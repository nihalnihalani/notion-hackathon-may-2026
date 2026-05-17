'use client';

/**
 * Pass-rate trend (line chart).
 *
 * One line per agent name; X axis is day buckets over the last 30 days,
 * Y axis is the daily pass rate (0-1).
 *
 * Lines are themed in solid colors per agent so the legend stays scannable
 * — agents are a closed set of four (schema_smith, tool_coder, inspector,
 * shipper). If you ever extend AgentName, add a color to AGENT_COLORS.
 */
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { AgentName } from '@forge/db';
import { AGENT_NAME_LABEL } from '@/lib/colors';

export interface PassRatePoint {
  /** ISO date (YYYY-MM-DD) */
  date: string;
  /** Pass rate per agent, 0-1; missing key = no data that day. */
  rates: Partial<Record<AgentName, number>>;
}

interface PassRateChartProps {
  data: readonly PassRatePoint[];
}

const AGENT_COLORS: Record<AgentName, string> = {
  schema_smith: 'hsl(var(--primary))',
  tool_coder: 'hsl(var(--forge-accent))',
  inspector: 'hsl(var(--success))',
  shipper: 'hsl(var(--warning))',
};

const AGENT_KEYS: readonly AgentName[] = ['schema_smith', 'tool_coder', 'inspector', 'shipper'];

export function PassRateChart({ data }: PassRateChartProps) {
  const rows = data.map((d) => ({
    date: d.date,
    schema_smith: d.rates.schema_smith ?? null,
    tool_coder: d.rates.tool_coder ?? null,
    inspector: d.rates.inspector ?? null,
    shipper: d.rates.shipper ?? null,
  }));

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 24, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={[0, 1]}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            stroke="hsl(var(--muted-foreground))"
            fontSize={11}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--popover))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 8,
              fontSize: 12,
              color: 'hsl(var(--popover-foreground))',
            }}
            formatter={(v: number) => (typeof v === 'number' ? `${(v * 100).toFixed(0)}%` : v)}
          />
          <Legend
            wrapperStyle={{ fontSize: 12 }}
            formatter={(value: string) => AGENT_NAME_LABEL[value as AgentName] ?? value}
          />
          {AGENT_KEYS.map((agent) => (
            <Line
              key={agent}
              type="monotone"
              dataKey={agent}
              stroke={AGENT_COLORS[agent]}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
