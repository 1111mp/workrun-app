import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@workspace/ui/components';
import {
  BotIcon,
  CircleStopIcon,
  GitBranchIcon,
  Globe2Icon,
  Layers3Icon,
  SplitIcon,
  type LucideIcon,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { DraggableCore, type DraggableData } from 'react-draggable';

type WorkflowNodePaletteItem = {
  type: WorkflowNodeType;
  label: string;
  description: string;
  icon: LucideIcon;
  iconClassName: string;
};

const nodeGroups: {
  label: string;
  items: WorkflowNodePaletteItem[];
}[] = [
  {
    label: 'Agents',
    items: [
      {
        type: 'agent',
        label: 'Agent',
        description: 'Run a local ADK agent',
        icon: BotIcon,
        iconClassName: 'text-violet-500',
      },
      {
        type: 'remote_agent',
        label: 'Remote Agent',
        description: 'Call an agent over the network',
        icon: Globe2Icon,
        iconClassName: 'text-sky-500',
      },
    ],
  },
  {
    label: 'Control flow',
    items: [
      {
        type: 'end',
        label: 'End',
        description: 'Workflow exit point',
        icon: CircleStopIcon,
        iconClassName: 'text-rose-500',
      },
      {
        type: 'if_else',
        label: 'If / Else',
        description: 'Route execution by condition',
        icon: GitBranchIcon,
        iconClassName: 'text-amber-500',
      },
      {
        type: 'switch',
        label: 'Switch',
        description: 'Route execution by case',
        icon: SplitIcon,
        iconClassName: 'text-cyan-500',
      },
    ],
  },
  {
    label: 'Layout',
    items: [
      {
        type: 'group',
        label: 'Group',
        description: 'Organize nodes into a movable layout',
        icon: Layers3Icon,
        iconClassName: 'text-sky-500',
      },
    ],
  },
];

type WorkflowSidebarProps = {
  onNodeDrop: (type: WorkflowNodeType, x: number, y: number) => void;
};

type DraggablePaletteItemProps = {
  item: WorkflowNodePaletteItem;
  onDragStart: (
    item: WorkflowNodePaletteItem,
    event: MouseEvent,
    data: DraggableData,
  ) => void;
  onDrag: (event: MouseEvent) => void;
  onDragStop: (event: MouseEvent) => void;
};

function DraggablePaletteItem({
  item,
  onDragStart,
  onDrag,
  onDragStop,
}: DraggablePaletteItemProps) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const Icon = item.icon;

  return (
    <DraggableCore
      nodeRef={nodeRef}
      onStart={(event, data) => onDragStart(item, event, data)}
      onDrag={onDrag}
      onStop={onDragStop}
    >
      <div ref={nodeRef}>
        <SidebarMenuButton
          tooltip={item.label}
          className='h-auto cursor-grab py-2 active:cursor-grabbing'
        >
          <Icon className={item.iconClassName} aria-hidden='true' />
          <span className='flex min-w-0 flex-col gap-0.5'>
            <span>{item.label}</span>
            <span className='text-muted-foreground text-xs font-normal'>
              {item.description}
            </span>
          </span>
        </SidebarMenuButton>
      </div>
    </DraggableCore>
  );
}

function WorkflowSidebar({ onNodeDrop }: WorkflowSidebarProps) {
  const [dragging, setDragging] = useState<{
    item: WorkflowNodePaletteItem;
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
    width: number;
    hasMoved: boolean;
  } | null>(null);

  const onDragStart = (
    item: WorkflowNodePaletteItem,
    event: MouseEvent,
    data: DraggableData,
  ) => {
    const rect = data.node.getBoundingClientRect();
    setDragging({
      item,
      x: event.clientX,
      y: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      hasMoved: false,
    });
  };

  const onDrag = (event: MouseEvent) => {
    setDragging((current) =>
      current
        ? { ...current, x: event.clientX, y: event.clientY, hasMoved: true }
        : null,
    );
  };

  const onDragStop = (event: MouseEvent) => {
    const item = dragging?.item;
    const dropTarget = document.elementFromPoint(event.clientX, event.clientY);
    const droppedOnCanvas = dropTarget?.closest('.react-flow');

    setDragging(null);
    if (item && droppedOnCanvas) {
      onNodeDrop(item.type, event.clientX, event.clientY);
    }
  };

  const DragIcon = dragging?.item.icon;

  return (
    <Sidebar variant='inset'>
      <SidebarHeader>
        <div className='px-2 py-1'>
          <p className='font-semibold'>Add node</p>
          <p className='text-muted-foreground text-xs'>Drag onto the canvas</p>
        </div>
      </SidebarHeader>
      <SidebarSeparator />
      <SidebarContent>
        {nodeGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.type}>
                    <DraggablePaletteItem
                      item={item}
                      onDragStart={onDragStart}
                      onDrag={onDrag}
                      onDragStop={onDragStop}
                    />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      {dragging?.hasMoved && (
        <div
          className='bg-sidebar text-sidebar-foreground ring-sidebar-border pointer-events-none fixed z-[100] rounded-md px-2 py-2 opacity-95 shadow-xl ring-1'
          style={{
            left: dragging.x - dragging.offsetX,
            top: dragging.y - dragging.offsetY,
            width: dragging.width,
          }}
        >
          <div className='flex items-center gap-2 text-left text-sm'>
            {DragIcon && (
              <DragIcon
                className={dragging.item.iconClassName}
                aria-hidden='true'
              />
            )}
            <span className='flex min-w-0 flex-col gap-0.5'>
              <span>{dragging.item.label}</span>
              <span className='text-muted-foreground text-xs font-normal'>
                {dragging.item.description}
              </span>
            </span>
          </div>
        </div>
      )}
    </Sidebar>
  );
}

export { WorkflowSidebar };
