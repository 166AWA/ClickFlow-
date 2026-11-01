import * as ToggleGroup from "@radix-ui/react-toggle-group";
import * as SliderPrimitive from "@radix-ui/react-slider";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn, prettyCombo } from "../lib/utils";

/* ---------------------------------------------------------------- */
/*  卡片                                                             */
/* ---------------------------------------------------------------- */

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-line bg-surface p-3.5 shadow-[var(--shadow-card)]",
        className
      )}
    >
      {children}
    </section>
  );
}

export function CardTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-fg-subtle">
        {children}
      </h2>
      {action}
    </div>
  );
}

export function Row({
  label,
  children,
  hidden,
}: {
  label: ReactNode;
  children: ReactNode;
  hidden?: boolean;
}) {
  if (hidden) return null;
  return (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <span className="text-[12.5px] text-fg-muted">{label}</span>
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/*  分段控件（Radix ToggleGroup）                                     */
/* ---------------------------------------------------------------- */

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  stretch?: boolean;
  className?: string;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  stretch,
  className,
}: SegmentedProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => next && onChange(next as T)}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-[9px] border border-line bg-surface-2 p-[3px]",
        stretch && "w-full",
        className
      )}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          className={cn(
            "rounded-[6px] px-2.5 py-[3px] text-[11.5px] font-medium text-fg-muted transition-all duration-150",
            "hover:text-fg",
            "data-[state=on]:bg-surface-3 data-[state=on]:text-fg data-[state=on]:shadow-[0_1px_2px_rgba(0,0,0,0.25)]",
            stretch && "flex-1 text-center"
          )}
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

/* ---------------------------------------------------------------- */
/*  图标按钮                                                          */
/* ---------------------------------------------------------------- */

export function IconButton({
  icon: Icon,
  label,
  active,
  danger,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  danger?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "grid size-7 place-items-center rounded-[7px] text-fg-subtle transition-all duration-150",
        "hover:bg-surface-2 hover:text-fg",
        active && "bg-primary-soft text-primary",
        danger && "hover:bg-danger-soft hover:text-danger"
      )}
    >
      <Icon className="size-[15px]" strokeWidth={1.9} />
    </button>
  );
}

/* ---------------------------------------------------------------- */
/*  快捷键录制按钮                                                     */
/* ---------------------------------------------------------------- */

export function Keycap({
  combo,
  listening,
  onClick,
}: {
  combo: string;
  listening: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "min-w-[132px] rounded-lg border px-3 py-[6px] text-center font-mono text-[11.5px] font-semibold",
        "transition-all duration-150",
        listening
          ? "animate-breathe border-accent bg-accent/10 text-accent"
          : "border-line-strong bg-surface-2 text-fg hover:border-primary/60 hover:bg-primary-soft hover:text-primary"
      )}
    >
      {listening ? "按下按键…" : prettyCombo(combo)}
    </button>
  );
}

/* ---------------------------------------------------------------- */
/*  数字输入                                                          */
/* ---------------------------------------------------------------- */

export function NumberField({
  label,
  value,
  onChange,
  onBlur,
  min,
  max,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (raw: string) => void;
  onBlur: () => void;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[11px] text-fg-subtle">{label}</span>
      <div
        className={cn(
          "flex items-center gap-1 rounded-lg border border-line bg-surface-2 px-2 py-[6px]",
          "transition-colors duration-150 focus-within:border-primary/70"
        )}
      >
        <input
          type="number"
          inputMode="numeric"
          value={value}
          min={min}
          max={max}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          className="tnum w-full min-w-0 bg-transparent font-mono text-[12.5px] outline-none"
        />
        {suffix ? (
          <span className="shrink-0 text-[10px] text-fg-subtle">{suffix}</span>
        ) : null}
      </div>
    </label>
  );
}

/* ---------------------------------------------------------------- */
/*  间隔滑块（Radix Slider）                                          */
/* ---------------------------------------------------------------- */

export function IntervalSlider({
  value,
  onChange,
  min = 1,
  max = 1000,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <SliderPrimitive.Root
      value={[value]}
      min={min}
      max={max}
      step={1}
      onValueChange={([next]) => onChange(next)}
      className="relative flex h-5 w-full touch-none select-none items-center"
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-surface-3">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-gradient-to-r from-primary to-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className={cn(
          "block size-[15px] rounded-full border-[2.5px] border-primary bg-surface",
          "shadow-[0_1px_4px_rgba(0,0,0,0.3)] transition-transform duration-150",
          "hover:scale-110 focus-visible:scale-110 active:scale-105"
        )}
        aria-label="点击间隔"
      />
    </SliderPrimitive.Root>
  );
}

/* ---------------------------------------------------------------- */
/*  统计格                                                            */
/* ---------------------------------------------------------------- */

export function StatBox({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5 shadow-[var(--shadow-card)]">
      <div className="text-[9.5px] font-medium uppercase tracking-[0.1em] text-fg-subtle">
        {label}
      </div>
      <div
        className={cn(
          "tnum mt-0.5 font-mono text-[15px] font-semibold leading-tight",
          highlight ? "text-accent" : "text-fg"
        )}
      >
        {value}
      </div>
    </div>
  );
}
