"use client";

import { BarChart, Bar, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, PieChart, Pie, Cell } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

const colors = ["#1F7A8C", "#4CC9F0", "#22C55E", "#F59E0B", "#64748B", "#A855F7"];

function fmt(value) {
  return Number(value || 0).toLocaleString("en-US");
}

export function AdminDashboardCharts({ trend, models, todayTokens, labels }) {
  const chartTrend = trend?.length ? trend : [{ date: labels.noUsage, messages: 0, activeDevices: 0 }];
  const chartModels = models?.length ? models : [{ model: labels.noModel, messages: 1 }];

  return (
    <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader>
          <CardTitle>{labels.usageTrend}</CardTitle>
          <span className="font-mono text-sm text-slate-500">{fmt(todayTokens)} {labels.tokensToday}</span>
        </CardHeader>
        <CardContent>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartTrend}>
                <CartesianGrid stroke="#E2E8F0" vertical={false} />
                <XAxis dataKey="date" tickFormatter={(value) => String(value).slice(5)} tickLine={false} axisLine={false} fontSize={12} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} />
                <Tooltip formatter={(value) => fmt(value)} />
                <Bar dataKey="messages" fill="#1F7A8C" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{labels.modelUsage}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={chartModels} dataKey="messages" nameKey="model" innerRadius={56} outerRadius={82} paddingAngle={3}>
                  {chartModels.map((row, index) => (
                    <Cell key={row.model} fill={colors[index % colors.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => fmt(value)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 space-y-3">
            {chartModels.map((row, index) => (
              <div key={row.model} className="flex justify-between gap-3 text-sm">
                <span className="truncate">
                  <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: colors[index % colors.length] }} />
                  {row.model}
                </span>
                <span className="font-mono">{fmt(row.messages)}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
