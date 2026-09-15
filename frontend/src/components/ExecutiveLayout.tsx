import React from 'react';

interface ExecutiveLayoutProps {
  header: React.ReactNode;
  kpis: React.ReactNode;
  alerts?: React.ReactNode;
  analytics: React.ReactNode;
  operations?: React.ReactNode;
  customers?: React.ReactNode;
}

export function ExecutiveLayout({
  header,
  kpis,
  alerts,
  analytics,
  operations,
  customers
}: ExecutiveLayoutProps) {
  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-6 max-w-[1600px] mx-auto w-full">
      {/* 1. Compact Header */}
      <section className="mb-6">
        {header}
      </section>

      {/* 2. KPIs / Sparklines */}
      <section>
        {kpis}
      </section>

      {/* 3. Alerts (Optional) */}
      {alerts && (
        <section>
          {alerts}
        </section>
      )}

      {/* 4. Revenue Analytics */}
      <section>
        {analytics}
      </section>

      {/* 5. Operations (Optional) */}
      {operations && (
        <section>
          {operations}
        </section>
      )}

      {/* 6. Customers / Tables (Optional) */}
      {customers && (
        <section>
          {customers}
        </section>
      )}
    </div>
  );
}
