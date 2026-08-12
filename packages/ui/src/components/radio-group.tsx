import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { cn } from '@workspace/ui/lib/utils';

type RadioGroupProps = RadioGroupPrimitive.Props & {
  orientation?: 'horizontal' | 'vertical';
};

function RadioGroup({
  className,
  orientation = 'vertical',
  ...props
}: RadioGroupProps) {
  return (
    <RadioGroupPrimitive
      data-slot='radio-group'
      data-orientation={orientation}
      aria-orientation={orientation}
      className={cn(
        'gap-2',
        orientation === 'horizontal'
          ? 'flex w-fit flex-row items-center'
          : 'grid w-full',
        className,
      )}
      {...props}
    />
  );
}

function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot='radio-group-item'
      className={cn(
        'group/radio-group-item peer relative flex aspect-square size-4 shrink-0 rounded-full border border-input outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary',
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot='radio-group-indicator'
        className='flex size-4 items-center justify-center'
      >
        <span className='bg-primary-foreground absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full' />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem, type RadioGroupProps };
