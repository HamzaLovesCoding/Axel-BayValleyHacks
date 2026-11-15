// Home-screen icon: the same mark as the header, built from divs because next/og renders a
// subset of CSS and plain boxes are the safest part of it.
export function AppIcon({ size }: { size: number }) {
  const disc = size * 0.56;
  const dot = size * 0.12;
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a0a",
      }}
    >
      <div
        style={{
          width: disc,
          height: disc / 2,
          borderTopLeftRadius: disc / 2,
          borderTopRightRadius: disc / 2,
          background: "#f3f2ee",
          marginTop: size * 0.04,
        }}
      />
      <div style={{ width: dot, height: dot, borderRadius: dot, background: "#ff5a14", marginTop: size * 0.07 }} />
    </div>
  );
}
