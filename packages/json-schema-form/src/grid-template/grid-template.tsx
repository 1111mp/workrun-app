import type { GridTemplateProps } from '@rjsf/utils';
import { cn } from '@workspace/ui/lib/utils';
import type { CSSProperties } from 'react';

type WorkrunGridTemplateProps = GridTemplateProps & {
  columns?: number;
  span?: number;
};

/** Renders RJSF layout-grid rows and columns with CSS Grid. */
export default function GridTemplate({
  children,
  column,
  className,
  columns,
  span,
  style,
  ...rest
}: WorkrunGridTemplateProps) {
  const gridStyle: CSSProperties = {
    ...style,
    ...(columns && !column
      ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
      : {}),
    ...(column && span ? { gridColumn: `span ${span} / span ${span}` } : {}),
  };

  return (
    <div
      className={cn(column ? 'min-w-0' : 'grid gap-2', className)}
      style={gridStyle}
      {...rest}
    >
      {children}
    </div>
  );
}
