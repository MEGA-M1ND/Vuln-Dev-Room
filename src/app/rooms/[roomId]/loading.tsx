export default function RoomLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-screen items-center justify-center text-sm text-muted-foreground"
    >
      Loading room…
    </div>
  );
}
