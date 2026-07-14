import dns from 'node:dns';
dns.setServers(['1.1.1.1', '1.0.0.1']);
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { MongoClient, ServerApiVersion, ObjectId, Db, Collection } from 'mongodb';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import Stripe from 'stripe';
import {
  AuthRequest,
  StoryDocument,
  BookmarkDocument,
  ReportDocument,
  PaymentDocument,
  UserDocument,
} from './types';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

app.use(cors({ credentials: true, origin: [process.env.CLIENT_URL || 'http://localhost:3000'] }));

app.use('/api/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));

const client = new MongoClient(process.env.MONGODB_URI || '', {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

let db: Db;
let storiesCollection: Collection<StoryDocument>;
let bookmarksCollection: Collection<BookmarkDocument>;
let reportsCollection: Collection<ReportDocument>;
let paymentsCollection: Collection<PaymentDocument>;
let userCollection: Collection<UserDocument>;

// JWKS from Next.js (not from Express anymore)
const JWKS = createRemoteJWKSet(new URL(`http://localhost:3000/api/auth/jwks`));

// ===== Helpers =====

const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ALLOWED_SORT_FIELDS = new Set(['createdAt', 'likesCount', 'budget', 'travelYear']);

const clampLimit = (raw: unknown, fallback: number, max = 50) => {
  const n = parseInt(raw as string) || fallback;
  return Math.min(Math.max(n, 1), max);
};

const toObjectId = (id: string): ObjectId | null => {
  if (!ObjectId.isValid(id)) return null;
  return new ObjectId(id);
};

const verifyToken = async (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ msg: 'Unauthorized' });
  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ msg: 'Unauthorized' });
  try {
    const { payload } = await jwtVerify(token, JWKS);
    const user = payload as AuthRequest['user'];
    if (user?.isBlocked) return res.status(403).json({ msg: 'Account blocked' });
    req.user = user;
    next();
  } catch { return res.status(401).json({ msg: 'Unauthorized' }); }
};

const verifyAdmin = (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ msg: 'Forbidden' });
  next();
};

async function run() {
  try {
    await client.connect();
    db = client.db('wanderlust');
    storiesCollection = db.collection<StoryDocument>('stories');
    bookmarksCollection = db.collection<BookmarkDocument>('bookmarks');
    reportsCollection = db.collection<ReportDocument>('reports');
    paymentsCollection = db.collection<PaymentDocument>('payments');
    userCollection = db.collection<UserDocument>('user');

    // ===== STORIES =====
    app.get('/api/stories', async (req, res) => {
      try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = clampLimit(req.query.limit, 12);
        const query: Record<string, unknown> = { status: { $ne: 'removed' } };
        if (req.query.continent) query.continent = { $in: (req.query.continent as string).split(',').map(c => c.trim()) };
        if (req.query.country) query.country = { $regex: escapeRegex(req.query.country as string), $options: 'i' };
        if (req.query.search) query.title = { $regex: escapeRegex(req.query.search as string), $options: 'i' };
        if (req.query.featured === 'true') query.isFeatured = true;
        const requestedSort = req.query.sort as string;
        const sortField = ALLOWED_SORT_FIELDS.has(requestedSort) ? requestedSort : 'createdAt';
        const total = await storiesCollection.countDocuments(query);
        const stories = await storiesCollection.find(query)
          .sort({ [sortField]: -1 })
          .skip((page - 1) * limit).limit(limit).toArray();
        res.json({ stories, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/stories/popular', async (_req, res) => {
      try { const stories = await storiesCollection.find({ status: { $ne: 'removed' } }).sort({ likesCount: -1 }).limit(6).toArray(); res.json({ stories }); }
      catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/stories/my-stories', verifyToken, async (req: AuthRequest, res) => {
      try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = clampLimit(req.query.limit, 10);
        const total = await storiesCollection.countDocuments({ travelerId: req.user?.sub });
        const stories = await storiesCollection.find({ travelerId: req.user?.sub }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray();
        res.json({ stories, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/stories/:id', async (req, res) => {
      try {
        const id = toObjectId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid story id' });
        const story = await storiesCollection.findOne({ _id: id });
        if (!story) return res.status(404).json({ error: 'Not found' });
        res.json({ story });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/stories', verifyToken, async (req: AuthRequest, res) => {
      try {
        if (!req.user?.isPremium) {
          const count = await storiesCollection.countDocuments({ travelerId: req.user?.sub });
          if (count >= 3) return res.status(403).json({ error: 'Free limit: 3 stories. Get Premium!' });
        }
        const { title, coverImage, images, country, city, continent, travelMonth, travelYear, duration, budget, description, highlights, tips } = req.body;
        if (!title || !coverImage || !country || !continent || !description) return res.status(400).json({ error: 'Missing required fields' });
        if (!req.user) return res.status(401).json({ msg: 'Unauthorized' });
        const doc: StoryDocument = {
          title, coverImage, images: images || [], country, city: city || '', continent,
          travelMonth: travelMonth || '', travelYear: travelYear || new Date().getFullYear(),
          duration: duration || '', budget: parseFloat(budget) || 0, description,
          highlights: highlights || [], tips: tips || [],
          travelerId: req.user.sub, travelerName: req.user.name, travelerEmail: req.user.email,
          likesCount: 0, likedBy: [], isFeatured: false, status: 'active',
          createdAt: new Date(), updatedAt: new Date(),
        };
        const result = await storiesCollection.insertOne(doc);
        res.status(201).json({ story: { ...doc, _id: result.insertedId } });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/stories/:id/like', verifyToken, async (req: AuthRequest, res) => {
      try {
        const id = toObjectId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid story id' });
        const story = await storiesCollection.findOne({ _id: id });
        if (!story) return res.status(404).json({ error: 'Not found' });
        const liked = story.likedBy?.includes(req.user?.sub || '');
        if (liked) { await storiesCollection.updateOne({ _id: id }, { $pull: { likedBy: req.user?.sub }, $inc: { likesCount: -1 } }); }
        else { await storiesCollection.updateOne({ _id: id }, { $addToSet: { likedBy: req.user?.sub }, $inc: { likesCount: 1 } }); }
        const updated = await storiesCollection.findOne({ _id: id });
        res.json({ likesCount: updated?.likesCount, liked: !liked });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.delete('/api/stories/:id', verifyToken, async (req: AuthRequest, res) => {
      try {
        const id = toObjectId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid story id' });
        const story = await storiesCollection.findOne({ _id: id });
        if (!story) return res.status(404).json({ error: 'Not found' });
        if (story.travelerId !== req.user?.sub && req.user?.role !== 'admin') {
          return res.status(403).json({ error: 'Not authorized to delete this story' });
        }
        await storiesCollection.deleteOne({ _id: id });
        res.json({ success: true });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    // ===== BOOKMARKS =====
    app.get('/api/bookmarks', verifyToken, async (req: AuthRequest, res) => {
      try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = clampLimit(req.query.limit, 10);
        const total = await bookmarksCollection.countDocuments({ userId: req.user?.sub });
        const data = await bookmarksCollection.find({ userId: req.user?.sub }).sort({ addedAt: -1 }).skip((page - 1) * limit).limit(limit).toArray();
        const populated = await Promise.all(data.map(async (b) => {
          const storyObjectId = toObjectId(b.storyId);
          if (!storyObjectId) return { ...b, storyId: null };
          const s = await storiesCollection.findOne({ _id: storyObjectId });
          return { ...b, storyId: s };
        }));
        res.json({ bookmarks: populated, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/bookmarks', verifyToken, async (req: AuthRequest, res) => {
      try {
        if (!req.body.storyId || !ObjectId.isValid(req.body.storyId)) return res.status(400).json({ error: 'Invalid story id' });
        const existing = await bookmarksCollection.findOne({ userId: req.user?.sub, storyId: req.body.storyId });
        if (existing) return res.status(400).json({ error: 'Already bookmarked' });
        const r = await bookmarksCollection.insertOne({ userId: req.user?.sub as string, storyId: req.body.storyId, addedAt: new Date() });
        res.status(201).json({ bookmark: { _id: r.insertedId } });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.delete('/api/bookmarks/:storyId', verifyToken, async (req: AuthRequest, res) => {
      try { await bookmarksCollection.deleteOne({ userId: req.user?.sub, storyId: req.params.storyId }); res.json({ success: true }); }
      catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    // ===== REPORTS =====
    app.post('/api/reports', verifyToken, async (req: AuthRequest, res) => {
      try {
        if (!req.body.storyId || !req.body.reason) return res.status(400).json({ error: 'Missing required fields' });
        const r = await reportsCollection.insertOne({
          storyId: req.body.storyId,
          reporterEmail: req.user?.email as string,
          reason: req.body.reason,
          status: 'pending',
          createdAt: new Date(),
        });
        res.status(201).json({ report: { _id: r.insertedId } });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    // ===== STRIPE =====
    app.post('/api/create-checkout-session', verifyToken, async (req: AuthRequest, res) => {
      try {
        const { type = 'premium' } = req.body;
        const lineItems = [{ price_data: { currency: 'usd', product_data: { name: 'WanderLust Premium Traveler' }, unit_amount: 1299 }, quantity: 1 }];
        const metadata: Record<string, string> = { userId: req.user?.sub || '', userEmail: req.user?.email || '', type };
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'], line_items: lineItems, mode: 'payment',
          success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_URL}/`, metadata,
        });
        res.json({ url: session.url });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.post('/api/webhooks/stripe', async (req, res) => {
      try {
        const sig = req.headers['stripe-signature'] as string;
        const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
        if (event.type === 'checkout.session.completed') {
          const session = event.data.object as Stripe.Checkout.Session;
          const { userId } = session.metadata as Record<string, string>;
          if (userId && ObjectId.isValid(userId)) {
            await paymentsCollection.insertOne({
              userId,
              amount: session.amount_total ? session.amount_total / 100 : 0,
              transactionId: session.id,
              paymentStatus: 'completed',
              type: 'premium',
              paidAt: new Date(),
            });
            await userCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { isPremium: true } });
          }
        }
        res.json({ received: true });
      } catch (e) { res.status(400).json({ error: (e as Error).message }); }
    });

    app.get('/api/user/stats', verifyToken, async (req: AuthRequest, res) => {
      try {
        const totalStories = await storiesCollection.countDocuments({ travelerId: req.user?.sub });
        const totalBookmarks = await bookmarksCollection.countDocuments({ userId: req.user?.sub });
        const userStories = await storiesCollection.find({ travelerId: req.user?.sub }).toArray();
        const totalLikes = userStories.reduce((s, r) => s + (r.likesCount || 0), 0);
        res.json({ totalStories, totalBookmarks, totalLikes });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    // ===== ADMIN =====
    app.get('/api/admin/dashboard', verifyToken, verifyAdmin, async (_req, res) => {
      try {
        const [totalUsers, totalStories, premiumUsers, totalReports] = await Promise.all([
          userCollection.countDocuments(), storiesCollection.countDocuments(),
          userCollection.countDocuments({ isPremium: true }), reportsCollection.countDocuments({ status: 'pending' }),
        ]);
        res.json({ totalUsers, totalStories, premiumUsers, totalReports });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/admin/users', verifyToken, verifyAdmin, async (_req, res) => {
      try { const users = await userCollection.find({}).toArray(); res.json({ users }); }
      catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.put('/api/admin/users/:id/toggle-block', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = toObjectId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid user id' });
        if (typeof req.body.isBlocked !== 'boolean') return res.status(400).json({ error: 'isBlocked must be boolean' });
        await userCollection.updateOne({ _id: id }, { $set: { isBlocked: req.body.isBlocked } });
        res.json({ success: true });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.get('/api/admin/stories', verifyToken, verifyAdmin, async (_req, res) => {
      try { const stories = await storiesCollection.find({}).sort({ createdAt: -1 }).toArray(); res.json({ stories }); }
      catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.patch('/api/admin/stories/:id/feature', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const id = toObjectId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid story id' });
        if (typeof req.body.isFeatured !== 'boolean') return res.status(400).json({ error: 'isFeatured must be boolean' });
        await storiesCollection.updateOne({ _id: id }, { $set: { isFeatured: req.body.isFeatured } });
        res.json({ success: true });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

    app.delete('/api/admin/stories/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid story id' });
    const story = await storiesCollection.findOne({ _id: id });
    if (!story) return res.status(404).json({ error: 'Not found' });
    await storiesCollection.deleteOne({ _id: id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

    app.get('/api/admin/reports', verifyToken, verifyAdmin, async (_req, res) => {
      try {
        const data = await reportsCollection.find({}).sort({ createdAt: -1 }).toArray();
        const populated = await Promise.all(data.map(async (r) => {
          const storyObjectId = toObjectId(r.storyId);
          if (!storyObjectId) return { ...r, storyId: null };
          const s = await storiesCollection.findOne({ _id: storyObjectId });
          return { ...r, storyId: s };
        }));
        res.json({ reports: populated });
      } catch (e) { res.status(500).json({ error: (e as Error).message }); }
    });

//     app.patch('/api/admin/reports/:id', verifyToken, verifyAdmin, async (req, res) => {
//       try {
//         const id = toObjectId(req.params.id);
//         if (!id) return res.status(400).json({ error: 'Invalid report id' });
//         if (req.body.action === 'dismiss') {
//           await reportsCollection.updateOne({ _id: id }, { $set: { status: 'dismissed' } });
//         } else if (req.body.action === 'remove_story') {
//           const report = await reportsCollection.findOne({ _id: id });
//           const storyObjectId = report ? toObjectId(report.storyId) : null;
//           if (report && storyObjectId) {
//             await storiesCollection.updateOne({ _id: storyObjectId }, { $set: { status: 'removed' } });
//             await reportsCollection.updateOne({ _id: id }, { $set: { status: 'resolved' } });
//           }
//         } else {
//           return res.status(400).json({ error: 'Unknown action' });
//         }
//         res.json({ success: true });
//       } catch (e) { res.status(500).json({ error: (e as Error).message }); }
//     });

//     app.get('/', (_req, res) => res.send('WanderLust Server Running!'));
//     await client.db('admin').command({ ping: 1 });
//     console.log('✅ MongoDB connected!');
//   } finally {
//     // intentionally empty
//   }
// }
// run().catch(console.dir);
// app.listen(PORT, () => console.log(`🚀 WanderLust Server on ${PORT}`));