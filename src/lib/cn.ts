import { extendTailwindMerge } from 'tailwind-merge'

/** tailwind-merge, taught about the custom shadows and animations defined in index.css. */
const merge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ['card', 'pop'],
      animate: ['fade-in', 'pane-in', 'pop-in', 'dialog-in', 'flash', 'shimmer'],
    },
  },
})

/** Joins class names, skipping falsy values; later classes win over conflicting earlier ones. */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return merge(classes.filter(Boolean).join(' '))
}
