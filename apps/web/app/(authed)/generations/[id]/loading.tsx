import { Skeleton } from '@/components/ui/skeleton';

export default function GenerationLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-36 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
