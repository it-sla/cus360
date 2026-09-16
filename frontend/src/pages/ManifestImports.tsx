import { Link } from 'react-router-dom';

export default function ManifestImports() {
  return (
    <div className="p-8 max-w-lg">
      <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">Manifest Imports</h1>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        Not available yet — manifests are currently imported via CRM Sync. This page isn't linked from
        anywhere in the app; if you followed a bookmark or old link here, use{' '}
        <Link to="/app/sync" className="text-primary hover:underline">CRM Sync</Link> instead.
      </p>
    </div>
  );
}
