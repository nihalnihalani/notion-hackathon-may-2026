import { Skeleton } from '@/components/ui/skeleton';

export default function AgentDetailLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-32 w-full rounded-xl" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  );
}
