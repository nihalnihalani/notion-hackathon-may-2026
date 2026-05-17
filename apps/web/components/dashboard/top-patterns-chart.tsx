'use client';

/**
 * Top patterns chart — horizontal bar chart for the Overview page.
 *
 * Client component because Recharts depends on the browser SVG/measurement
 * APIs. The data shape is pre-aggregated server-side; this component is
 * purely presentational.
 *
 * Sizing:
 *   - `ResponsiveContainer` reads its parent's width. Bound the chart to a
 *     fixed height so the parent card doesn't grow unbounded on first paint.
 *   - Axis tick + bar colors all reference our CSS-variable tokens through
 *     inline `style` (Recharts doesn't accept Tailwind class names on its
 *     SVG primitives).
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface TopPatternsChartProps {
  data: ReadonlyArray<{ name: string; count: number }>;
}

export function TopPatternsChart({ data }: TopPatternsChartProps) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={[...data]}
          layout="vertical"
          margin={{ top: 6, right: 16, bottom: 6, left: 8 }}
          barCategoryGap={12}
        >
          <CartesianGrid
            stroke="hsl(var(--border))"
            strokeDasharray="3 3"
            horizontal={false}
          />
          <XAxis
            type="number"
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            stroke="hsl(var(--muted-foreground))"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            width={120}
          />
          <Tooltip
            cursor={{ fill: 'hsl(var(--accent) / 0.4)' }}
            contentStyle={{
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 8,
              fontSize: 12,
              color: 'hsl(var(--popover-foreground))',
            }}
          />
          <Bar dataKey="count" radius={[0, 4, 4, 0]}>
            {data.map((_, i) => (
              <Cell
                key={i}
                fill={i === 0 ? 'hsl(var(--primary))' : 'hsl(var(--primary) / 0.55)'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
