/**
 * Feature card used by the landing page.
 *
 * Server-component-friendly. The icon is passed as a `LucideIcon` reference
 * (not a JSX element) so the parent doesn't have to instantiate the icon
 * with styling concerns — this component owns the icon framing.
 */
import type { LucideIcon } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';

interface FeatureCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
}

export function FeatureCard({
  icon: Icon,
  title,
  description,
}: FeatureCardProps) {
  return (
    <Card className="border-border/60 bg-card/80 backdrop-blur transition hover:border-primary/40 hover:shadow-md">
      <CardContent className="flex flex-col gap-3 p-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-forge-gradient text-primary-foreground shadow-sm shadow-forge-primary/30">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
        <h3 className="text-base font-semibold tracking-tight">{title}</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </CardContent>
    </Card>
  );
}
