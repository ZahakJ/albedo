// Compose's icon set: 14×14 strokes on currentColor, drawn for this UI.
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.15, strokeLinecap: 'round', strokeLinejoin: 'round' }

const P = {
  move: <path {...S} d="M7 1v12M3.8 4.2L7 1l3.2 3.2M3.8 9.8L7 13l3.2-3.2M1 7h12M4.2 3.8L1 7l3.2 3.2M9.8 3.8L13 7l-3.2 3.2" />,
  marquee: <path {...S} d="M2 3.5v-1a.5.5 0 0 1 .5-.5h1M6 2h2M10.5 2h1a.5.5 0 0 1 .5.5v1M12 6v2M12 10.5v1a.5.5 0 0 1-.5.5h-1M8 12H6M3.5 12h-1a.5.5 0 0 1-.5-.5v-1M2 8V6" />,
  ellipse: <ellipse {...S} cx="7" cy="7" rx="5.5" ry="4.2" strokeDasharray="2 1.6" />,
  lasso: <path {...S} d="M4.2 10.4C2.2 9.6 1.3 8.2 1.6 6.6 2.1 4 5 2.2 8.2 2.6c3 .4 4.6 2.4 4.1 4.6-.4 2-2.8 3.4-5.6 3.4M4.2 10.4c-.6 1-.3 2.2.8 2.6M4.2 10.4c.8-.4 1.8-.3 2.4.2" />,
  poly: <path {...S} d="M2 11l1.6-7.5 5 2.2L12 2.4l-.8 9.4z" strokeDasharray="2 1.4" />,
  wand: <path {...S} d="M2 12l6.5-6.5M9.5 1.5v2M12.5 4.5h-2M11.6 2.4l-1.2 1.2M7.5 2.6l.7.7M11.4 6.5l-.7-.7" />,
  aiselect: <path {...S} d="M6.5 1.5l1.1 3.2 3.2 1.1-3.2 1.1-1.1 3.2-1.1-3.2L2.2 5.8l3.2-1.1zM11 9l.5 1.4 1.4.5-1.4.5L11 12.8l-.5-1.4-1.4-.5 1.4-.5z" />,
  crop: <path {...S} d="M3.5 1v9.5H13M1 3.5h9.5V13" />,
  brush: <path fill="currentColor" d="M11.7 1.6c.6.6.7 1.5.1 2.1L6.5 9.4 4 10.9l-.9-.9L4.6 7.5l5.7-5.7c.6-.6 1.5-.5 2.1-.2zM3.2 10.8c-.4 1-1.1 1.6-2.2 1.8.5-.9.5-1.6.9-2.3z" />,
  eraser: <path {...S} d="M5.5 12h6M2 9.5l6-6a1.2 1.2 0 0 1 1.7 0l2.3 2.3a1.2 1.2 0 0 1 0 1.7L8.5 11a1.6 1.6 0 0 1-2.3 0L2 9.5zM6.2 4.8l4 4" />,
  smudge: <path {...S} d="M8.6 1.8c.8.8.8 2 .1 2.7L6.4 6.8c-.5.5-.5 1.3 0 1.8l.3.3M6.7 8.9c.6.6.6 1.5 0 2.1l-.9.9c-.8.8-2.2.8-3 0s-.8-2.2 0-3l3.1-3.1M9.5 6.5c1.5.3 2.5 1.2 3 2.6" />,
  clone: <path {...S} d="M4.5 6.5h5v-1a2.5 2.5 0 0 0-5 0v1zM2.5 9c0-1.4 1.1-2.5 2.5-2.5h4c1.4 0 2.5 1.1 2.5 2.5M2 11.5h10M7 6.5v2.5" />,
  heal: <path {...S} d="M3.4 10.6L10.6 3.4a1.9 1.9 0 0 1 2.7 2.7l-7.2 7.2a1.9 1.9 0 0 1-2.7-2.7zM.7 7.9l7.2-7.2M5.6 6.4l.1.1M7.6 8.4l.1.1M6.4 5.6l.1.1M8.4 7.6l.1.1" />,
  dodge: <path {...S} d="M7 13V7.6M4.2 4.8a2.8 2.8 0 1 0 5.6 0 2.8 2.8 0 0 0-5.6 0z" />,
  gradient: <><rect {...S} x="1.5" y="3" width="11" height="8" rx="1" /><path d="M2 3.5h2.7v7H2z" fill="currentColor" opacity=".85" /><path d="M4.7 3.5h2.7v7H4.7z" fill="currentColor" opacity=".45" /><path d="M7.4 3.5h2.7v7H7.4z" fill="currentColor" opacity=".18" /></>,
  text: <path {...S} d="M2.5 4V2.5h9V4M7 2.5V11.5M5 11.5h4" />,
  shape: <><rect {...S} x="1.5" y="1.5" width="7" height="7" rx="1" /><circle {...S} cx="9" cy="9" r="3.5" /></>,
  hand: <path {...S} d="M4.5 7.5V3.2a1 1 0 0 1 2 0V6M6.5 6V2.2a1 1 0 0 1 2 0V6M8.5 6V3a1 1 0 0 1 2 0v4.6c0 2.8-1.7 4.9-4.3 4.9-2 0-3-1-4-2.8L1.3 7.8a.9.9 0 0 1 1.5-1l1.7 1.9" />,
  zoom: <><circle {...S} cx="6" cy="6" r="4.2" /><path {...S} d="M9.2 9.2L13 13M4 6h4M6 4v4" /></>,
  eyedropper: <path {...S} d="M8.8 3.4l1.8 1.8M10.3 1.9a1.3 1.3 0 0 1 1.8 1.8L10.6 5.2 8.8 3.4zM8.8 3.4L2.6 9.6 2 12l2.4-.6 6.2-6.2" />,
  liquify: <path {...S} d="M1.5 4.5c2-2 3.5 2 5.5 0s3.5 2 5.5 0M1.5 9.5c2-2 3.5 2 5.5 0s3.5 2 5.5 0" />,
  transform: <><rect {...S} x="2.5" y="2.5" width="9" height="9" /><path d="M1.2 1.2h2.6v2.6H1.2zM10.2 1.2h2.6v2.6h-2.6zM1.2 10.2h2.6v2.6H1.2zM10.2 10.2h2.6v2.6h-2.6z" fill="currentColor" /></>,
  eye: <><path {...S} d="M1 7c1.6-2.8 3.6-4.2 6-4.2S11.4 4.2 13 7c-1.6 2.8-3.6 4.2-6 4.2S2.6 9.8 1 7z" /><circle cx="7" cy="7" r="1.8" fill="currentColor" /></>,
  eyeOff: <path {...S} opacity=".4" d="M1 7c1.6-2.8 3.6-4.2 6-4.2S11.4 4.2 13 7c-1.6 2.8-3.6 4.2-6 4.2S2.6 9.8 1 7zM2.5 2.5l9 9" />,
  lock: <><rect {...S} x="3" y="6" width="8" height="6" rx="1" /><path {...S} d="M4.8 6V4.4a2.2 2.2 0 0 1 4.4 0V6" /></>,
  clip: <path {...S} d="M3 2v5.5a2 2 0 0 0 2 2h6M8.5 7l2.5 2.5L8.5 12" />,
  chevRight: <path {...S} d="M5.5 3.5L9 7l-3.5 3.5" />,
  chevDown: <path {...S} d="M3.5 5.5L7 9l3.5-3.5" />,
  adjust: <><circle {...S} cx="7" cy="7" r="5" /><path d="M7 2a5 5 0 0 1 0 10z" fill="currentColor" /></>,
  folder: <path {...S} d="M1.5 3.5a1 1 0 0 1 1-1h3l1.3 1.5h4.7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />,
  fill: <><rect {...S} x="2" y="2" width="10" height="10" rx="1.5" /><path d="M2.5 12l9.5-9.5V11a1 1 0 0 1-1 1z" fill="currentColor" opacity=".7" /></>,
  smart: <><rect {...S} x="1.5" y="2.5" width="11" height="9" rx="1" /><path {...S} d="M1.5 9.5l3.2-3 2.3 2.2 2-1.7 3.5 3" /><circle cx="9.5" cy="5.2" r="1" fill="currentColor" /></>,
  mask: <><rect {...S} x="1.5" y="2.5" width="11" height="9" rx="1" /><circle cx="7" cy="7" r="2.6" fill="currentColor" /></>,
  plus: <path {...S} d="M7 2v10M2 7h10" />,
  trash: <path {...S} d="M2.5 3.5h9M5.5 3.5V2h3v1.5M3.5 3.5l.6 8.5h5.8l.6-8.5M6 5.5v4.5M8 5.5v4.5" />,
  swap: <path {...S} d="M3 5.5V4a1.5 1.5 0 0 1 1.5-1.5H9M7.5 1l1.5 1.5L7.5 4M11 8.5V10a1.5 1.5 0 0 1-1.5 1.5H5M6.5 13L5 11.5 6.5 10" />,
  reset: <><rect x="1" y="1" width="5" height="5" fill="currentColor" /><rect {...S} x="4.5" y="4.5" width="5" height="5" /></>,
  undo: <path {...S} d="M4.5 4.5L2 7l2.5 2.5M2 7h6.5a3.5 3.5 0 0 1 0 7" />,
  develop: <><circle {...S} cx="7" cy="7" r="5.5" /><path {...S} d="M7 1.5v3M7 9.5v3M1.5 7h3M9.5 7h3" /></>,
  layers: <path {...S} d="M7 1.5l5.5 3L7 7.5l-5.5-3zM1.5 7L7 10l5.5-3M1.5 9.5L7 12.5l5.5-3" />,
}

export function Icon({ name, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className="co-icon">
      {P[name] ?? null}
    </svg>
  )
}
