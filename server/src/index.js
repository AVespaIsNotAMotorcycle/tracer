import mongoose from 'mongoose';
import app from './app.js';

const port = process.env.PORT || 5000;

if (process.env.MONGODB_URI) {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
  }
} else {
  console.warn('MONGODB_URI not set; skipping database connection');
}

app.listen(port, () => console.log(`Server listening on port ${port}`));
