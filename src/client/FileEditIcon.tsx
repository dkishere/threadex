import type { SVGProps } from "react";

/**
 * Solid file-edit mark used for file changes. It intentionally has a heavier
 * silhouette than the regular Pencil action icon so file edits read as a
 * document operation at small sizes.
 */
export function FileEditIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      focusable="false"
      {...props}
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M4.75 1.5h10.5L22.5 8v11.25a3.25 3.25 0 0 1-3.25 3.25H4.75a3.25 3.25 0 0 1-3.25-3.25V4.75A3.25 3.25 0 0 1 4.75 1.5Zm.5 3a.75.75 0 0 0-.75.75v14a.75.75 0 0 0 .75.75h14a.75.75 0 0 0 .75-.75V9.62l-5.12-5.12H5.25Z"
        clipRule="evenodd"
      />
      <path
        fill="currentColor"
        d="m11.72 14.12 6.92-6.92 2.58 2.58-6.92 6.92-3.55 1.1 1.1-3.68a.2.2 0 0 1-.13 0Zm-2.13 5.42 1.08-3.54 2.47 2.47-3.54 1.08a.1.1 0 0 1-.01-.01Zm9.73-15.9 1.71-1.71a1.1 1.1 0 0 1 1.56 0l1.14 1.14a1.1 1.1 0 0 1 0 1.56l-1.71 1.71-2.7-2.7Z"
      />
    </svg>
  );
}
