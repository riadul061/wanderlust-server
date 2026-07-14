import { Request } from 'express';
import { ObjectId } from 'mongodb';

export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  isPremium: boolean;
  isBlocked: boolean;
  [key: string]: unknown;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

export interface StoryDocument {
  title: string;
  coverImage: string;
  images: string[];
  country: string;
  city: string;
  continent: string;
  travelMonth: string;
  travelYear: number;
  duration: string;
  budget: number;
  description: string;
  highlights: string[];
  tips: string[];
  travelerId: string;
  travelerName: string;
  travelerEmail: string;
  likesCount: number;
  likedBy: string[];
  isFeatured: boolean;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BookmarkDocument {
  userId: string;
  storyId: string;
  addedAt: Date;
}

export interface ReportDocument {
  storyId: string;
  reporterEmail: string;
  reason: string;
  status: 'pending' | 'dismissed' | 'resolved';
  createdAt: Date;
}

export interface PaymentDocument {
  userId: string;
  amount: number;
  transactionId: string;
  paymentStatus: string;
  type: string;
  paidAt: Date;
}

export interface UserDocument {
  _id?: ObjectId;
  name: string;
  email: string;
  role: 'user' | 'admin';
  isPremium: boolean;
  isBlocked: boolean;
  [key: string]: unknown;
}