
import { Outlet } from "react-router-dom";
import { AppShell } from "@/components/app-shell";
import { Dashboard } from "@/components/dashboard";

export function EfferdDashboard2() {
  return (
    <AppShell>
      <Dashboard>
        <Outlet />
      </Dashboard>
    </AppShell>
  );
}

export default EfferdDashboard2;
