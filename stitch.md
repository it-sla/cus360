# Courier Intelligence Dashboard Design Reference

## Overview
An enterprise-grade analytics dashboard for "Shangrila Tours Intelligence". The layout is a classic dense B2B SaaS dashboard tailored for business analysts. It uses a dark sidebar with a light content area.

## Color Palette
- **Sidebar Background**: Dark Teal `#193638`
- **Sidebar Active Items**: Teal `#254648` with a thin gold border.
- **Main Background**: Off-white `#F4F7F6` or `slate-50`.
- **Text**: `slate-900` for headings, `slate-500` for secondary text.
- **Accents**: 
  - Emerald/Teal for primary buttons and positive indicators.
  - Rose/Red for negative indicators.
  - Amber/Gold for KPI icons and alerts.

## Layout Structure
1. **Left Sidebar (250px wide)**:
   - **Header**: Logo placeholder (orange box) with "Courier Intelligence" and "Shangrila Tours Intelligence" subtext.
   - **Sections** (Text size small, uppercase, bold teal color):
     - **INTELLIGENCE**: Executive overview (Active state), Business analytics, Universal search.
     - **OPERATIONS**: Customer directory, Air waybills, Master air waybills.
     - **GOVERNANCE**: CRM synchronization, Matching review, Data quality.
   - **Footer**: Green dot "All systems operational".

2. **Top Header**:
   - White background, light gray bottom border.
   - Left: Logo "Shangrila Tours Intelligence".
   - Center: Search bar with "Search anything" and "⌘K" shortcut key.
   - Right: Badge "Role: Administrator" and user profile chip "S" "System Administrator".

3. **Content Area (Padding 32px)**:
   - **Toolbar Row**:
     - Left: Buttons for "Sync" (dark brown), "Export", "Refresh icon", "Backup".
     - Right: Dropdown buttons for "Last 30 Days", "Saved Views", "Filters on Page" (with badge '1').
   - **Page Slicers Box**:
     - White card, subtle border.
     - Top row: "STATUS:" followed by pills (all, active, quiet, dormant, inactive, new). "Country: All", "AE: All AEs" dropdowns.
     - Bottom row: "REVENUE:" filters (All, <$10k, $10k-$50k, etc.) and a yellow "Clear Slicers" button.
   - **Active Slicers Row**: Text "Active Slicers: Last 30 Days" and a badge "Showing 82 of 82 customers".
   - **Tab Navigation**:
     - Tabs: "Overview" (active, dark teal background), "Analytics & Charts", "Growth Ledger", "AE Leaderboard & Insights".
   - **4 KPI Cards (Grid cols 4)**:
     - Each card: White background, subtle border, rounded corners.
     - Top row of card: Title (e.g. "TOTAL REVENUE", uppercase, amber text) and a bronze/amber icon (Dollar, Users, UserPlus, Package) inside a pale yellow box.
     - Middle row of card: Large bold value (e.g. "$133,395", "82", "+5", "657").
     - Bottom row of card: Trend badge (e.g. red "-31.4%", red "-13.7%", yellow "+25.0%") and subtext ("vs previous period").
   - **Chart Section**:
     - Large white card, title "Revenue Growth Trend".
     - Recharts Area chart with a smooth curved line, dark green stroke, and light green/teal gradient fill.
