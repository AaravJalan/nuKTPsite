import { useEffect, useState } from "react";

export default function ProfileAvatar({
  src,
  name,
  className = "",
  loading,
  decoding,
}: {
  src: string;
  name: string;
  className?: string;
  loading?: "lazy" | "eager";
  decoding?: "async" | "sync" | "auto";
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [src]);

  const initial = (name.trim().charAt(0) || "?").toUpperCase();
  if (!src || failed) {
    return (
      <div
        className={`portal-avatar-placeholder ${className}`.trim()}
        aria-hidden="true"
      >
        {initial}
      </div>
    );
  }

  return (
    <img
      className={className}
      src={src}
      alt=""
      loading={loading}
      decoding={decoding}
      onError={() => setFailed(true)}
    />
  );
}
