/**
 * @file About tab for the admin panel.
 */
export default function AboutTab() {
  return (
    <div>
      <h1 className="adm-title">About the Admin Panel</h1>

      <div style={{ maxWidth: 720, lineHeight: 1.7, color: '#cbd5e1' }}>
        <h3>Purpose</h3>
        <p>
          This admin interface provides diagnostic and validation tools for the
          Catalunya Preferida heatmap engine. It is intentionally <strong>not linked</strong> from
          the main application — access requires knowing the URL and the password.
        </p>

        <h3>Terrain Aspect Verification</h3>
        <p>
          The <em>Terrain Aspect</em> tab generates synthetic DEMs (cones, ridges, pyramids, etc.)
          and verifies that the aspect-scoring pipeline correctly identifies the preferred
          orientation. Key formula:
        </p>
        <pre style={{ background: '#1a1d23', padding: 12, borderRadius: 6, overflowX: 'auto' }}>
{`aspect = atan2(-dz_dx, dz_dy)   // downhill bearing, geographic convention
score  = 0.5 + 0.5 * cos(aspect - preferredAzimuth) * strength`}
        </pre>
        <p>
          The octant assertions check that the highest-scoring octant aligns with the
          preferred azimuth and that the opposite octant scores lowest.
        </p>

        <h3>Catalonia Real DEM</h3>
        <p>
          Elevation data is fetched from the <a href="https://open-meteo.com/en/docs/elevation-api" target="_blank" rel="noreferrer">Open-Meteo Elevation API</a>.
          The fetcher includes <strong>exponential backoff</strong> on HTTP 429 responses
          (up to 5 retries, starting at 500 ms, doubling each attempt). A 120 ms courtesy
          delay is inserted between chunks to reduce rate-limit hits.
        </p>

        <h3>Data Integrity</h3>
        <p>
          The integrity tab loads all resource JSON files from the <code>public/resources/</code>
          directory and runs the same validation checks used by the main application:
          coverage, completeness, duplicate detection, outlier analysis, freshness, and
          cross-field consistency. Rules and taxonomy can be tuned and exported as JSON profiles.
        </p>

        <h3>Security</h3>
        <p>
          The password gate is a simple client-side hash check stored in <code>sessionStorage</code>.
          It is <strong>not</strong> a security boundary — it merely prevents casual access.
          No sensitive data is exposed by this panel.
        </p>

        <h3>Build</h3>
        <p>
          The admin panel is built as a separate Vite entry point (<code>admin.html</code>)
          using <code>build.rollupOptions.input</code>. It shares the same <code>node_modules</code>,
          TypeScript config, and store with the main application but runs as its own React root.
        </p>
      </div>
    </div>
  );
}
