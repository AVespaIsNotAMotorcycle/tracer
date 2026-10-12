// Source types (OpenAlex `type` values) with a label and icon for each.
//
// Each icon comes in two forms from the same lucide release: the lucide-react component for
// the DOM (legend, details panel), and the vanilla `lucide` element data for drawing on the
// graph canvas. Keep the two packages on the same version so they match.
import {
  Binary,
  Book,
  BookA,
  BookOpenText,
  ClipboardList,
  Code,
  Database,
  File,
  FileChartColumn,
  FileClock,
  FileText,
  FileWarning,
  FileX,
  GraduationCap,
  Layers,
  Library,
  Mail,
  MessageSquareQuote,
  MessagesSquare,
  Mic,
  Newspaper,
  Paperclip,
  Presentation,
  Ruler,
  StickyNote,
} from 'lucide-react';
import {
  Binary as BinaryShape,
  Book as BookShape,
  BookA as BookAShape,
  BookOpenText as BookOpenTextShape,
  ClipboardList as ClipboardListShape,
  Code as CodeShape,
  Database as DatabaseShape,
  File as FileShape,
  FileChartColumn as FileChartColumnShape,
  FileClock as FileClockShape,
  FileText as FileTextShape,
  FileWarning as FileWarningShape,
  FileX as FileXShape,
  GraduationCap as GraduationCapShape,
  Layers as LayersShape,
  Library as LibraryShape,
  Mail as MailShape,
  MessageSquareQuote as MessageSquareQuoteShape,
  MessagesSquare as MessagesSquareShape,
  Mic as MicShape,
  Newspaper as NewspaperShape,
  Paperclip as PaperclipShape,
  Presentation as PresentationShape,
  Ruler as RulerShape,
  StickyNote as StickyNoteShape,
} from 'lucide';

/** @type {Record<string, { label: string, Icon: import('react').ComponentType<any>, shape: Array<[string, Record<string, string>]> }>} */
const SOURCE_TYPES = {
  article: { label: 'Article', Icon: FileText, shape: FileTextShape },
  book: { label: 'Book', Icon: Book, shape: BookShape },
  'book-chapter': { label: 'Book chapter', Icon: BookOpenText, shape: BookOpenTextShape },
  'book-review': { label: 'Book review', Icon: MessageSquareQuote, shape: MessageSquareQuoteShape },
  review: { label: 'Review article', Icon: Layers, shape: LayersShape },
  'conference-paper': { label: 'Conference paper', Icon: Presentation, shape: PresentationShape },
  'conference-abstract': { label: 'Conference abstract', Icon: Mic, shape: MicShape },
  dissertation: { label: 'Dissertation', Icon: GraduationCap, shape: GraduationCapShape },
  preprint: { label: 'Preprint', Icon: FileClock, shape: FileClockShape },
  report: { label: 'Report', Icon: ClipboardList, shape: ClipboardListShape },
  dataset: { label: 'Dataset', Icon: Database, shape: DatabaseShape },
  'data-paper': { label: 'Data paper', Icon: FileChartColumn, shape: FileChartColumnShape },
  editorial: { label: 'Editorial', Icon: Newspaper, shape: NewspaperShape },
  letter: { label: 'Letter', Icon: Mail, shape: MailShape },
  'reference-entry': { label: 'Reference entry', Icon: BookA, shape: BookAShape },
  erratum: { label: 'Erratum', Icon: FileWarning, shape: FileWarningShape },
  retraction: { label: 'Retraction', Icon: FileX, shape: FileXShape },
  paratext: { label: 'Front or back matter', Icon: StickyNote, shape: StickyNoteShape },
  'peer-review': { label: 'Peer review', Icon: MessagesSquare, shape: MessagesSquareShape },
  standard: { label: 'Standard', Icon: Ruler, shape: RulerShape },
  software: { label: 'Software', Icon: Code, shape: CodeShape },
  'software-paper': { label: 'Software paper', Icon: Binary, shape: BinaryShape },
  'supplementary-materials': {
    label: 'Supplementary material',
    Icon: Paperclip,
    shape: PaperclipShape,
  },
  libguides: { label: 'Library guide', Icon: Library, shape: LibraryShape },
  other: { label: 'Other', Icon: File, shape: FileShape },
};

/**
 * The display info for a work's type. Unknown or missing types fall back to "Other".
 *
 * @param {string | null | undefined} type
 */
export function sourceType(type) {
  const key = type && SOURCE_TYPES[type] ? type : 'other';
  return { key, ...SOURCE_TYPES[key] };
}

const num = (value) => Number(value ?? 0);

/**
 * Converts lucide element data ([tag, attrs] pairs on a 24x24 grid) into one SVG path string,
 * for `new Path2D(...)`. Lucide icons are stroke-only, so outlines are all that's needed.
 *
 * @param {Array<[string, Record<string, string>]>} elements
 */
export function iconPathData(elements) {
  return elements
    .map(([tag, a]) => {
      switch (tag) {
        case 'path':
          return a.d;
        case 'line':
          return `M${num(a.x1)} ${num(a.y1)}L${num(a.x2)} ${num(a.y2)}`;
        case 'polyline':
        case 'polygon': {
          const points = a.points
            .trim()
            .split(/[\s,]+/)
            .map(Number);
          let d = `M${points[0]} ${points[1]}`;
          for (let i = 2; i < points.length; i += 2) d += `L${points[i]} ${points[i + 1]}`;
          return tag === 'polygon' ? `${d}Z` : d;
        }
        case 'circle':
        case 'ellipse': {
          const cx = num(a.cx);
          const cy = num(a.cy);
          const rx = num(a.r ?? a.rx);
          const ry = num(a.r ?? a.ry);
          return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
        }
        case 'rect': {
          const x = num(a.x);
          const y = num(a.y);
          const w = num(a.width);
          const h = num(a.height);
          const rx = Math.min(num(a.rx ?? a.ry), w / 2);
          const ry = Math.min(num(a.ry ?? a.rx), h / 2);
          if (!rx || !ry) return `M${x} ${y}h${w}v${h}h${-w}Z`;
          return (
            `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}` +
            `V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}` +
            `H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
            `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
          );
        }
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('');
}

const pathCache = new Map();

/**
 * A cached Path2D for a type's icon on a 24x24 grid, or null where Path2D isn't available
 * (e.g. jsdom).
 *
 * @param {string | null | undefined} type
 */
export function iconPath2D(type) {
  if (typeof Path2D === 'undefined') return null;
  const { key, shape } = sourceType(type);
  if (!pathCache.has(key)) pathCache.set(key, new Path2D(iconPathData(shape)));
  return pathCache.get(key);
}
