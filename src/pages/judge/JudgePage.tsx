import { AppHeader, SimBadge } from '@/components/ride/bits'

export default function JudgePage() {
  return (
    <div className="flex h-dvh flex-col">
      <AppHeader title="Judge console"><SimBadge /></AppHeader>
      <main className="p-6 text-sm text-muted-foreground">Judge console is being built in the next slice.</main>
    </div>
  )
}
