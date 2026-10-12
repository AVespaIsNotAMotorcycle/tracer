import mongoose from 'mongoose';

// A signed-in session. The browser holds a random token in an httpOnly cookie; only its
// SHA-256 hash is stored (as _id), so a leaked database doesn't leak usable sessions.
const sessionSchema = new mongoose.Schema({
  _id: { type: String },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  createdAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});

// MongoDB deletes expired sessions in the background; reads also check expiresAt.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model('Session', sessionSchema);
