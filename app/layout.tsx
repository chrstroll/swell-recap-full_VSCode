export const metadata = { title:'The Weather Recap', description:'Last week + next week at a glance' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial', background:'#f7fafb' }}>
        {children}
      </body>
    </html>
  );
}
