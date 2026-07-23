"use client";

import * as React from "react";

import { cn, colorForId, initials } from "@/lib/utils";

export interface AvatarProps {
  name: string;
  id?: string;
  image?: string | null;
  color?: string;
  size?: number;
  className?: string;
  ring?: boolean;
}

/**
 * Accessible avatar. The name is always exposed to assistive tech via the
 * `title` + `aria-label`; color is never the sole identifier.
 */
export function Avatar({
  name,
  id,
  image,
  color,
  size = 32,
  className,
  ring,
}: AvatarProps) {
  const bg = color ?? (id ? colorForId(id) : "#64748b");
  const dimension = { width: size, height: size, fontSize: size * 0.4 };

  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-white",
        ring && "ring-2 ring-offset-2 ring-offset-background",
        className,
      )}
      style={{
        ...dimension,
        backgroundColor: image ? undefined : bg,
        ...(ring ? ({ "--tw-ring-color": bg } as React.CSSProperties) : {}),
      }}
    >
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- external avatar URLs, metadata only
        <img
          src={image}
          alt={name}
          width={size}
          height={size}
          className="h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
    </span>
  );
}
