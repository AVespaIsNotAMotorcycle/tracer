/**
 * Tracer's logo mark: a tilted index card with pins joined by thread. Drawn in currentColor,
 * so it follows the surrounding text color in light and dark mode. Decorative by default,
 * since it's shown next to the "Tracer" name; pass a `title` to give it an accessible name.
 */
export default function TracerMark({ size = 32, style = {}, title }) {
  const labelProps = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true };
  return (
    <svg
	  width={size}
	  height={size}
	  style={style}
	  viewBox="0 0 100 100"
	  fill="none" {...labelProps}
	>
      <rect
        x="14"
        y="14"
        width="72"
        height="72"
        rx="6"
        transform="rotate(-7 50 50)"
        stroke="currentColor"
        strokeWidth="4.5"
      />
      <polyline
        points="31,33 70,41 38,69 69,70"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <g fill="currentColor">
        <circle cx="31" cy="33" r="8.5" />
        <circle cx="70" cy="41" r="7.5" />
        <circle cx="38" cy="69" r="7.5" />
        <circle cx="69" cy="70" r="5.5" />
      </g>
    </svg>
  );
}
