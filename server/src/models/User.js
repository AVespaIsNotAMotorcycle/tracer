import mongoose from 'mongoose';
import { ACCOUNT_PLANS } from '../entitlements/plans.js';

// An account. How someone signs in to it lives in Identity records, so one account can have
// several sign-in methods (a password now; ORCID or Google later) without changing this.
const userSchema = new mongoose.Schema({
  // Lowercased and trimmed. Unique: it's how accounts are found and shown.
  email: { type: String, required: true, unique: true },
  createdAt: { type: Date, required: true },
  // What the account includes (see entitlements/plans.js). Billing will set it.
  plan: { type: String, enum: ACCOUNT_PLANS, default: 'free' },
  // Per-account changes to the plan, e.g. for testers: { features: { pathSearch: false },
  // limits: { maxNodes: 50 } }. Unknown keys are ignored.
  planOverrides: { type: mongoose.Schema.Types.Mixed, default: undefined },
});

export const User = mongoose.model('User', userSchema);
