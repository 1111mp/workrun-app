import type {
  FormContextType,
  IconButtonProps,
  RJSFSchema,
  StrictRJSFSchema,
} from '@rjsf/utils';
import { TranslatableString } from '@rjsf/utils';
import { Button } from '@workspace/ui/components/button';
import { cn } from '@workspace/ui/lib/utils';
import { PlusCircle } from 'lucide-react';

/**
 * A button component for adding new items in a form
 * @param uiSchema - The UI schema for the form, which can include custom properties
 * @param registry - The registry object containing the form's configuration and utilities
 * @param className - Allow custom class names to be passed for Tailwind CSS styling
 * @param props - The component properties
 */
export default function AddButton<
  T = any,
  S extends StrictRJSFSchema = RJSFSchema,
  F extends FormContextType = any,
>({
  uiSchema: _uiSchema,
  registry,
  className,
  ...props
}: IconButtonProps<T, S, F>) {
  const { translateString } = registry;
  return (
    <div className='m-0 p-0'>
      <Button
        {...props}
        className={cn('w-fit gap-2', className)}
        variant='outline'
        type='button'
      >
        <PlusCircle size={16} />{' '}
        {translateString(TranslatableString.AddItemButton)}
      </Button>
    </div>
  );
}
