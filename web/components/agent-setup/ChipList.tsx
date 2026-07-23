import styles from "./ChipList.module.css";

interface ChipListProps {
  label: string;
  items: string[];
  /** "inline" renders wrapped pill chips (Tone); "list" renders vertical bulleted rows (Do's/Don'ts). */
  layout?: "inline" | "list";
}

/** Read-only tag list for fixed placeholder content (see BrandVoiceWorkspace's Response framework / Guidelines sections). */
export function ChipList({ label, items, layout = "inline" }: ChipListProps) {
  return (
    <div className={styles.wrap}>
      <span className={styles.label}>{label}</span>
      <div className={`${styles.items} ${styles[layout]}`}>
        {items.map((item, i) => (
          <span key={`${item}-${i}`} className={layout === "inline" ? styles.chip : styles.row}>
            <span className={styles.text}>{item}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
