import mongoose from 'mongoose';

// An account. How someone signs in to it lives in Identity records, so one account can have
// several sign-in methods (a password now; ORCID or Google later) without changing this.
const userSchema = new mongoose.Schema({
  // Lowercased and trimmed. Unique: it's how accounts are found and shown.
  email: { type: String, required: true, unique: true },
  createdAt: { type: Date, required: true },
});

export const User = mongoose.model('User', userSchema);
