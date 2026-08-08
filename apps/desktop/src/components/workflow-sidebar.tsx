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
import type { DragEvent } from 'react';

const workflowNodeMimeType = 'application/workrun-node';

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

function onDragStart(
  event: DragEvent<HTMLButtonElement>,
  nodeType: WorkflowNodeType,
) {
  event.dataTransfer.setData(workflowNodeMimeType, nodeType);
  event.dataTransfer.setData('text/plain', nodeType);
  event.dataTransfer.effectAllowed = 'move';
}

function WorkflowSidebar() {
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
                {group.items.map((item) => {
                  const Icon = item.icon;

                  return (
                    <SidebarMenuItem key={item.type}>
                      <SidebarMenuButton
                        draggable
                        tooltip={item.label}
                        onDragStart={(event) => onDragStart(event, item.type)}
                        className='h-auto cursor-grab py-2 active:cursor-grabbing'
                      >
                        <Icon
                          className={item.iconClassName}
                          aria-hidden='true'
                        />
                        <span className='flex min-w-0 flex-col gap-0.5'>
                          <span>{item.label}</span>
                          <span className='text-muted-foreground text-xs font-normal'>
                            {item.description}
                          </span>
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  );
}

export { workflowNodeMimeType, WorkflowSidebar };
