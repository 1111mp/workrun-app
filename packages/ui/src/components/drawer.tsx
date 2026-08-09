import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer';
import { cn } from '@workspace/ui/lib/utils';
import * as React from 'react';

type HorizontalSnapPoint = number | string;

type DrawerContextProps = {
  hasHorizontalSnapPoints: boolean;
  hasSnapPoints: boolean;
  horizontalDragWidth: number | undefined;
  horizontalSnapPoint: HorizontalSnapPoint | undefined;
  horizontalSnapPoints: HorizontalSnapPoint[] | undefined;
  modal: DrawerPrimitive.Root.Props['modal'];
  setHorizontalDragWidth: (width: number | undefined) => void;
  setHorizontalSnapPoint: (snapPoint: HorizontalSnapPoint) => void;
  showSwipeHandle: boolean;
  swipeDirection: NonNullable<DrawerPrimitive.Root.Props['swipeDirection']>;
};

const DrawerContext = React.createContext<DrawerContextProps | null>(null);

function useDrawer() {
  const context = React.useContext(DrawerContext);

  if (!context) {
    throw new Error('useDrawer must be used within a Drawer.');
  }

  return context;
}

function Drawer({
  modal = true,
  showSwipeHandle = false,
  horizontalSnapPoints,
  defaultHorizontalSnapPoint,
  horizontalSnapPoint: controlledHorizontalSnapPoint,
  onHorizontalSnapPointChange,
  snapPoints,
  swipeDirection = 'down',
  ...props
}: DrawerPrimitive.Root.Props & {
  defaultHorizontalSnapPoint?: HorizontalSnapPoint;
  horizontalSnapPoint?: HorizontalSnapPoint;
  horizontalSnapPoints?: HorizontalSnapPoint[];
  onHorizontalSnapPointChange?: (snapPoint: HorizontalSnapPoint) => void;
  showSwipeHandle?: boolean;
}) {
  const hasSnapPoints = snapPoints != null && snapPoints.length > 0;
  const hasHorizontalSnapPoints =
    horizontalSnapPoints != null && horizontalSnapPoints.length > 0;
  const [uncontrolledHorizontalSnapPoint, setUncontrolledHorizontalSnapPoint] =
    React.useState<HorizontalSnapPoint | undefined>(
      defaultHorizontalSnapPoint ?? horizontalSnapPoints?.[0],
    );
  const [horizontalDragWidth, setHorizontalDragWidth] = React.useState<
    number | undefined
  >();
  const horizontalSnapPoint =
    controlledHorizontalSnapPoint ?? uncontrolledHorizontalSnapPoint;
  const setHorizontalSnapPoint = React.useCallback(
    (snapPoint: HorizontalSnapPoint) => {
      if (controlledHorizontalSnapPoint === undefined) {
        setUncontrolledHorizontalSnapPoint(snapPoint);
      }
      onHorizontalSnapPointChange?.(snapPoint);
    },
    [controlledHorizontalSnapPoint, onHorizontalSnapPointChange],
  );
  const contextValue = React.useMemo(
    () => ({
      hasHorizontalSnapPoints,
      hasSnapPoints,
      horizontalDragWidth,
      horizontalSnapPoint,
      horizontalSnapPoints,
      modal,
      setHorizontalDragWidth,
      setHorizontalSnapPoint,
      showSwipeHandle,
      swipeDirection,
    }),
    [
      hasHorizontalSnapPoints,
      hasSnapPoints,
      horizontalDragWidth,
      horizontalSnapPoint,
      horizontalSnapPoints,
      modal,
      setHorizontalDragWidth,
      setHorizontalSnapPoint,
      showSwipeHandle,
      swipeDirection,
    ],
  );

  return (
    <DrawerContext.Provider value={contextValue}>
      <DrawerPrimitive.Root
        data-slot='drawer'
        modal={modal}
        snapPoints={snapPoints}
        swipeDirection={swipeDirection}
        {...props}
      />
    </DrawerContext.Provider>
  );
}

function horizontalSnapPointCssValue(snapPoint: HorizontalSnapPoint) {
  if (typeof snapPoint === 'string') return snapPoint;
  return snapPoint > 0 && snapPoint <= 1
    ? `${snapPoint * 100}vw`
    : `${snapPoint}px`;
}

function horizontalSnapPointPixels(
  snapPoint: HorizontalSnapPoint,
  viewportWidth: number,
) {
  if (typeof snapPoint === 'number') {
    return snapPoint > 0 && snapPoint <= 1
      ? snapPoint * viewportWidth
      : snapPoint;
  }

  const value = Number.parseFloat(snapPoint);
  if (Number.isNaN(value)) return undefined;
  if (snapPoint.endsWith('px')) return value;
  if (snapPoint.endsWith('rem')) {
    return (
      value *
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    );
  }
  return undefined;
}

function DrawerTrigger({ ...props }: DrawerPrimitive.Trigger.Props) {
  return <DrawerPrimitive.Trigger data-slot='drawer-trigger' {...props} />;
}

function DrawerPortal({ ...props }: DrawerPrimitive.Portal.Props) {
  return <DrawerPrimitive.Portal data-slot='drawer-portal' {...props} />;
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot='drawer-close' {...props} />;
}

function DrawerOverlay({
  className,
  ...props
}: DrawerPrimitive.Backdrop.Props) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot='drawer-overlay'
      className={cn(
        'fixed inset-0 z-50 min-h-dvh bg-black/10 opacity-[max(var(--drawer-overlay-min-opacity,0),calc(1-var(--drawer-swipe-progress)))] transition-opacity duration-450 ease-[cubic-bezier(0.32,0.72,0,1)] select-none data-ending-style:pointer-events-none data-ending-style:opacity-0 data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-snap-points:[--drawer-overlay-min-opacity:0.5] data-starting-style:opacity-0 data-swiping:duration-0 supports-backdrop-filter:backdrop-blur-xs supports-[-webkit-touch-callout:none]:absolute',
        className,
      )}
      {...props}
    />
  );
}

function DrawerSwipeHandle({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='drawer-swipe-handle'
      aria-hidden='true'
      className={cn(
        'relative z-10 flex shrink-0 cursor-grab transition-opacity duration-200 group-data-nested-drawer-open/drawer-popup:opacity-0 group-data-nested-drawer-swiping/drawer-popup:opacity-100 group-data-[swipe-axis=x]/drawer-popup:h-full group-data-[swipe-axis=x]/drawer-popup:w-3 group-data-[swipe-axis=x]/drawer-popup:items-center group-data-[swipe-axis=y]/drawer-popup:h-3 group-data-[swipe-axis=y]/drawer-popup:w-full group-data-[swipe-axis=y]/drawer-popup:justify-center group-data-[swipe-direction=down]/drawer-popup:items-end group-data-[swipe-direction=left]/drawer-popup:order-last group-data-[swipe-direction=left]/drawer-popup:justify-start group-data-[swipe-direction=right]/drawer-popup:justify-end group-data-[swipe-direction=up]/drawer-popup:order-last group-data-[swipe-direction=up]/drawer-popup:items-start after:block after:shrink-0 after:rounded-full after:bg-muted group-data-[swipe-axis=x]/drawer-popup:after:h-24 group-data-[swipe-axis=x]/drawer-popup:after:w-1 group-data-[swipe-axis=y]/drawer-popup:after:h-1 group-data-[swipe-axis=y]/drawer-popup:after:w-24 active:cursor-grabbing',
        className,
      )}
      {...props}
    />
  );
}

function DrawerContent({
  className,
  children,
  style,
  ...props
}: DrawerPrimitive.Popup.Props) {
  const {
    hasHorizontalSnapPoints,
    hasSnapPoints,
    horizontalDragWidth,
    horizontalSnapPoint,
    modal,
    showSwipeHandle,
    swipeDirection,
  } = useDrawer();
  const swipeAxis =
    swipeDirection === 'down' || swipeDirection === 'up' ? 'y' : 'x';
  const width =
    swipeAxis === 'x' && horizontalDragWidth !== undefined
      ? `${horizontalDragWidth}px`
      : swipeAxis === 'x' && horizontalSnapPoint !== undefined
        ? horizontalSnapPointCssValue(horizontalSnapPoint)
        : undefined;

  return (
    <DrawerPortal data-slot='drawer-portal'>
      {modal === true && (
        <DrawerOverlay data-snap-points={hasSnapPoints ? '' : undefined} />
      )}
      <DrawerPrimitive.Viewport
        data-slot='drawer-viewport'
        data-modal={modal}
        className='pointer-events-none fixed inset-0 z-50 select-none data-[modal=true]:pointer-events-auto'
      >
        <DrawerPrimitive.Popup
          data-slot='drawer-popup'
          data-swipe-axis={swipeAxis}
          data-horizontal-snap-points={
            hasHorizontalSnapPoints && swipeAxis === 'x' ? '' : undefined
          }
          data-snap-points={hasSnapPoints ? '' : undefined}
          className={cn(
            // Base.
            'group/drawer-popup pointer-events-auto fixed z-50 m-(--drawer-inset,0px) flex h-(--drawer-content-height) max-h-(--drawer-content-max-height,none) min-h-0 w-(--drawer-content-width,auto) transform-[translate3d(var(--translate-x,0px),var(--translate-y,0px),0)_scale(var(--stack-scale))] flex-col bg-popover text-sm text-popover-foreground transition-[transform,height,width,opacity,filter] duration-450 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform outline-none select-none [interpolate-size:allow-keywords] data-[swipe-direction=down]:rounded-t-xl data-[swipe-direction=down]:border-t data-[swipe-direction=left]:rounded-r-xl data-[swipe-direction=left]:border-r data-[swipe-direction=right]:rounded-l-xl data-[swipe-direction=right]:border-l data-[swipe-direction=up]:rounded-b-xl data-[swipe-direction=up]:border-b',
            // Nested.
            'data-nested-drawer-open:overflow-hidden data-nested-drawer-open:brightness-95',
            // Bleed.
            'after:pointer-events-none after:absolute after:bg-(--drawer-bleed-background,var(--color-popover)) data-[swipe-axis=x]:after:inset-y-0 data-[swipe-axis=x]:after:w-(--bleed) data-[swipe-axis=y]:after:inset-x-0 data-[swipe-axis=y]:after:h-(--bleed) data-[swipe-direction=down]:after:top-full data-[swipe-direction=left]:after:right-full data-[swipe-direction=right]:after:left-full data-[swipe-direction=up]:after:bottom-full',
            // Sizing.
            '[--drawer-content-height:var(--drawer-height,auto)] data-[swipe-axis=x]:[--drawer-content-width:75%] data-[swipe-axis=y]:[--drawer-content-max-height:calc(100dvh-6rem)] data-[swipe-axis=y]:data-snap-points:[--drawer-content-height:100dvh] data-[swipe-axis=x]:sm:[--drawer-content-width:24rem]',
            // Stack.
            '[--bleed:3rem] [--peek:1rem] [--stack-height:var(--drawer-frontmost-height,var(--drawer-height,0px))] [--stack-peek-offset:max(0px,calc((var(--nested-drawers)-var(--stack-progress))*var(--peek)))] [--stack-progress:clamp(0,var(--drawer-swipe-progress),1)] [--stack-scale-base:max(0,calc(1-(var(--nested-drawers)*var(--stack-step))))] [--stack-scale:clamp(0,calc(var(--stack-scale-base)+(var(--stack-step)*var(--stack-progress))),1)] [--stack-shrink:calc(1-var(--stack-scale))] [--stack-step:0.05]',
            // Transitions.
            'data-ending-style:transform-(--closed-transform) data-ending-style:opacity-[0.9999] data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-nested-drawer-swiping:duration-0 data-ending-style:data-nested-drawer-swiping:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-starting-style:transform-(--closed-transform) data-swiping:duration-0 data-ending-style:data-swiping:duration-[calc(var(--drawer-swipe-strength)*400ms)]',
            // Axis: y.
            'data-[swipe-axis=y]:inset-x-0 data-[swipe-axis=y]:data-nested-drawer-open:h-(--stack-height)',
            // Axis: x.
            'data-[swipe-axis=x]:inset-y-0 data-[swipe-axis=x]:flex-row',
            // Direction: down.
            'data-[swipe-direction=down]:bottom-0 data-[swipe-direction=down]:origin-bottom data-[swipe-direction=down]:[--closed-transform:translate3d(0,calc(100%+var(--drawer-inset,0px)+2px),0)] data-[swipe-direction=down]:[--translate-y:calc(var(--drawer-snap-point-offset,0px)+var(--drawer-swipe-movement-y)-var(--stack-peek-offset)-(var(--stack-shrink)*var(--stack-height)))]',
            // Direction: up.
            'data-[swipe-direction=up]:top-0 data-[swipe-direction=up]:origin-top data-[swipe-direction=up]:[--closed-transform:translate3d(0,calc(-100%-var(--drawer-inset,0px)-2px),0)] data-[swipe-direction=up]:[--translate-y:calc(var(--drawer-snap-point-offset,0px)+var(--drawer-swipe-movement-y)+var(--stack-peek-offset)+(var(--stack-shrink)*var(--stack-height)))]',
            // Direction: left.
            'data-[swipe-direction=left]:left-0 data-[swipe-direction=left]:origin-left data-[swipe-direction=left]:[--closed-transform:translate3d(calc(-100%-var(--drawer-inset,0px)-2px),0,0)] data-[swipe-direction=left]:[--translate-x:calc(var(--drawer-swipe-movement-x)+var(--stack-peek-offset)+(var(--stack-shrink)*100%))]',
            // Direction: right.
            'data-[swipe-direction=right]:right-0 data-[swipe-direction=right]:origin-right data-[swipe-direction=right]:[--closed-transform:translate3d(calc(100%+var(--drawer-inset,0px)+2px),0,0)] data-[swipe-direction=right]:[--translate-x:calc(var(--drawer-swipe-movement-x)-var(--stack-peek-offset)-(var(--stack-shrink)*100%))]',
            className,
          )}
          style={(state) => {
            const resolvedStyle =
              typeof style === 'function' ? style(state) : style;
            return {
              ...resolvedStyle,
              maxWidth:
                swipeAxis === 'x' && hasHorizontalSnapPoints
                  ? 'calc(100vw - 2rem)'
                  : resolvedStyle?.maxWidth,
              transitionDuration:
                horizontalDragWidth !== undefined
                  ? '0ms'
                  : resolvedStyle?.transitionDuration,
              width: width ?? resolvedStyle?.width,
            };
          }}
          {...props}
        >
          {hasHorizontalSnapPoints && swipeAxis === 'x' ? (
            <DrawerHorizontalResizeHandle />
          ) : (
            showSwipeHandle && <DrawerSwipeHandle />
          )}
          <DrawerPrimitive.Content
            data-slot='drawer-content'
            className={cn(
              'flex min-h-0 flex-1 flex-col overflow-hidden overscroll-contain rounded-[inherit] transition-opacity duration-300 ease-[cubic-bezier(0.45,1.005,0,1.005)] select-text group-data-nested-drawer-open/drawer-popup:opacity-0 group-data-nested-drawer-swiping/drawer-popup:opacity-100 group-data-swiping/drawer-popup:select-none',
            )}
          >
            {children}
          </DrawerPrimitive.Content>
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPortal>
  );
}

function DrawerHorizontalResizeHandle() {
  const {
    horizontalSnapPoints,
    setHorizontalDragWidth,
    setHorizontalSnapPoint,
    swipeDirection,
  } = useDrawer();
  const resize = React.useRef<
    { startWidth: number; startX: number } | undefined
  >(undefined);
  const dragWidth = React.useRef<number | undefined>(undefined);

  const findClosestSnapPoint = React.useCallback(
    (width: number) => {
      if (!horizontalSnapPoints) return undefined;
      return horizontalSnapPoints.reduce<HorizontalSnapPoint | undefined>(
        (closest, snapPoint) => {
          const snapWidth = horizontalSnapPointPixels(
            snapPoint,
            window.innerWidth,
          );
          const closestWidth =
            closest === undefined
              ? undefined
              : horizontalSnapPointPixels(closest, window.innerWidth);
          if (snapWidth === undefined) return closest;
          if (
            closestWidth === undefined ||
            Math.abs(snapWidth - width) < Math.abs(closestWidth - width)
          ) {
            return snapPoint;
          }
          return closest;
        },
        undefined,
      );
    },
    [horizontalSnapPoints],
  );

  return (
    <div
      aria-label='Resize drawer width'
      aria-orientation='vertical'
      className='after:bg-muted hover:after:bg-border absolute top-1/2 left-0 z-10 flex h-24 w-3 -translate-y-1/2 cursor-ew-resize touch-none items-center justify-center transition-opacity duration-200 group-data-[swipe-direction=left]/drawer-popup:right-0 group-data-[swipe-direction=left]/drawer-popup:left-auto after:block after:h-16 after:w-1 after:rounded-full active:cursor-ew-resize'
      role='separator'
      onPointerDown={(event) => {
        const popup = event.currentTarget.closest<HTMLElement>(
          '[data-slot="drawer-popup"]',
        );
        if (!popup) return;
        event.preventDefault();
        event.stopPropagation();
        resize.current = {
          startWidth: popup.getBoundingClientRect().width,
          startX: event.clientX,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!resize.current) return;
        const delta = event.clientX - resize.current.startX;
        const nextWidth =
          swipeDirection === 'right'
            ? resize.current.startWidth - delta
            : resize.current.startWidth + delta;
        dragWidth.current = Math.max(
          16 * 12,
          Math.min(window.innerWidth - 32, nextWidth),
        );
        setHorizontalDragWidth(dragWidth.current);
      }}
      onPointerUp={() => {
        if (dragWidth.current !== undefined) {
          const snapPoint = findClosestSnapPoint(dragWidth.current);
          if (snapPoint !== undefined) setHorizontalSnapPoint(snapPoint);
        }
        resize.current = undefined;
        dragWidth.current = undefined;
        setHorizontalDragWidth(undefined);
      }}
      onPointerCancel={() => {
        resize.current = undefined;
        dragWidth.current = undefined;
        setHorizontalDragWidth(undefined);
      }}
    />
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='drawer-header'
      className={cn(
        'flex shrink-0 flex-col gap-0.5 p-4 pb-0 group-data-[swipe-axis=y]/drawer-popup:text-center md:gap-0.5 md:text-left',
        className,
      )}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot='drawer-footer'
      className={cn('mt-auto flex shrink-0 flex-col gap-2 p-4 pt-0', className)}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      data-slot='drawer-title'
      className={cn(
        'font-heading text-base font-medium text-foreground',
        className,
      )}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: DrawerPrimitive.Description.Props) {
  return (
    <DrawerPrimitive.Description
      data-slot='drawer-description'
      className={cn('text-sm text-balance text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  DrawerSwipeHandle,
  DrawerTitle,
  DrawerTrigger,
};
