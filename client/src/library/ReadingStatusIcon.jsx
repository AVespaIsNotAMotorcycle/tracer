import { BookCheck, Bookmark, BookOpen, Quote } from 'lucide-react';

// The same icons the graph draws on a work's status badge (GraphView.jsx).
const ICONS = { 'to-read': Bookmark, reading: BookOpen, read: BookCheck, cited: Quote };

/** The icon for a reading status, or nothing for none. */
export default function ReadingStatusIcon({ status, className = 'icon' }) {
  const Icon = ICONS[status];
  return Icon ? <Icon className={className} aria-hidden="true" /> : null;
}
