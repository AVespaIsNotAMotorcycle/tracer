import { useEffect, useRef } from 'react';

/**
 * A dialog over the page: labelled by its title, closed by Escape or a click on the backdrop.
 * Focus moves to the first field (or button) inside when it opens.
 */
export default function Modal({ titleId, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.querySelector('input, button')?.focus();
  }, []);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="dialog"
        onKeyDown={(event) => event.key === 'Escape' && onClose()}
      >
        {children}
      </div>
    </div>
  );
}
