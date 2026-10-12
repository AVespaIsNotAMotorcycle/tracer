import mongoose from 'mongoose';

// One way to sign in to an account. `provider` names the method and `subject` is the account's
// ID there: for 'password', the email; later, an ORCID iD for 'orcid' or the Google account ID
// for 'google'. Adding a method means adding a provider and its routes; accounts and sessions
// stay as they are.
const identitySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: String, required: true, enum: ['password'] },
  subject: { type: String, required: true },
  // 'password' only: from hashPassword.
  passwordHash: String,
  createdAt: { type: Date, required: true },
});

identitySchema.index({ provider: 1, subject: 1 }, { unique: true });

export const Identity = mongoose.model('Identity', identitySchema);
