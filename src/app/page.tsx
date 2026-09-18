"use client";

import { useState } from "react";
import ModelScene, { type ViewKey } from "@/components/ModelScene";

type StatusColor = "green" | "yellow" | "red";

interface HealthPanelData {
  summary: {
    title: string;
    description: string;
    score: number; // 0-100, drives the ring fill, letter grade, and color
  };
  metrics: {
    title: string;
    value: string;
    unit: string;
    status: string;
    statusColor: StatusColor;
  }[];
}

const healthDataByView: Record<ViewKey, HealthPanelData> = {
  reset: {
    summary: {
      title: "Overall Health",
      description:
        "Your overall health is in great condition. Your current health indicators are within healthy ranges, suggesting good physical well-being, balanced body function, and strong overall wellness.",
      score: 90,
    },
    metrics: [
      { title: "Biological Age", value: "27.5", unit: "years", status: "Optimal", statusColor: "green" },
      { title: "Resting Heart Rate", value: "62", unit: "bpm", status: "Optimal", statusColor: "green" },
      { title: "Blood Pressure", value: "118/76", unit: "mmHg", status: "Optimal", statusColor: "green" },
      { title: "Heart Rate Variability", value: "58", unit: "ms", status: "Normal", statusColor: "yellow" },
      { title: "Blood Oxygen", value: "98", unit: "%", status: "Optimal", statusColor: "green" },
      { title: "Cardio Fitness", value: "46.2", unit: "VO₂ max", status: "Optimal", statusColor: "green" },
    ],
  },
  heart: {
    summary: {
      title: "Heart Health",
      description:
        "Your heart is in great condition. Your current cardiovascular indicators are within healthy ranges, suggesting strong heart function and good overall cardiovascular fitness.",
      score: 93,
    },
    metrics: [
      { title: "Biological Age", value: "27.5", unit: "years", status: "Optimal", statusColor: "green" },
      { title: "Resting Heart Rate", value: "62", unit: "bpm", status: "Optimal", statusColor: "green" },
      { title: "Blood Pressure", value: "118/76", unit: "mmHg", status: "Optimal", statusColor: "green" },
      { title: "Heart Rate Variability", value: "58", unit: "ms", status: "Normal", statusColor: "yellow" },
      { title: "Blood Oxygen", value: "98", unit: "%", status: "Optimal", statusColor: "green" },
      { title: "Cardio Fitness", value: "46.2", unit: "VO₂ max", status: "Optimal", statusColor: "green" },
    ],
  },
  head: {
    summary: {
      title: "Head & Brain Health",
      description:
        "Your neurological indicators look healthy overall. Sleep quality and focus metrics are strong, with mild signs of screen-time strain worth keeping an eye on.",
      score: 78,
    },
    metrics: [
      { title: "Cognitive Score", value: "92", unit: "/100", status: "Optimal", statusColor: "green" },
      { title: "Sleep Quality", value: "84", unit: "/100", status: "Optimal", statusColor: "green" },
      { title: "Stress Level", value: "38", unit: "/100", status: "Normal", statusColor: "yellow" },
      { title: "Eye Strain", value: "Moderate", unit: "", status: "Watch", statusColor: "yellow" },
      { title: "Headache Frequency", value: "1", unit: "/week", status: "Normal", statusColor: "green" },
      { title: "Focus Duration", value: "48", unit: "min avg", status: "Optimal", statusColor: "green" },
    ],
  },
  arms: {
    summary: {
      title: "Arms & Grip Health",
      description:
        "Upper-body strength and mobility are within a healthy range. Grip strength is slightly below your baseline, likely tied to recent activity levels.",
      score: 66,
    },
    metrics: [
      { title: "Grip Strength", value: "38", unit: "kg", status: "Normal", statusColor: "yellow" },
      { title: "Range of Motion", value: "96", unit: "%", status: "Optimal", statusColor: "green" },
      { title: "Muscle Mass", value: "6.4", unit: "kg", status: "Optimal", statusColor: "green" },
      { title: "Joint Inflammation", value: "Low", unit: "", status: "Optimal", statusColor: "green" },
      { title: "Recovery Time", value: "18", unit: "hrs", status: "Normal", statusColor: "green" },
      { title: "Tremor Index", value: "0.2", unit: "Hz", status: "Optimal", statusColor: "green" },
    ],
  },
  kidney: {
    summary: {
      title: "Kidney Health",
      description:
        "Kidney function markers are within normal limits. Hydration levels are slightly low, which can affect filtration efficiency over time.",
      score: 64,
    },
    metrics: [
      { title: "GFR (Filtration Rate)", value: "98", unit: "mL/min", status: "Optimal", statusColor: "green" },
      { title: "Creatinine", value: "0.9", unit: "mg/dL", status: "Optimal", statusColor: "green" },
      { title: "Hydration Level", value: "62", unit: "%", status: "Normal", statusColor: "yellow" },
      { title: "Sodium Balance", value: "140", unit: "mmol/L", status: "Optimal", statusColor: "green" },
      { title: "Urine Protein", value: "Trace", unit: "", status: "Normal", statusColor: "yellow" },
      { title: "Blood Urea Nitrogen", value: "14", unit: "mg/dL", status: "Optimal", statusColor: "green" },
    ],
  },
  thyroid: {
    summary: {
      title: "Thyroid Health",
      description:
        "Thyroid hormone levels are balanced and within a healthy range, supporting normal metabolism and energy regulation.",
      score: 91,
    },
    metrics: [
      { title: "TSH", value: "2.1", unit: "mIU/L", status: "Optimal", statusColor: "green" },
      { title: "Free T4", value: "1.3", unit: "ng/dL", status: "Optimal", statusColor: "green" },
      { title: "Free T3", value: "3.2", unit: "pg/mL", status: "Optimal", statusColor: "green" },
      { title: "Metabolic Rate", value: "1,650", unit: "kcal/day", status: "Normal", statusColor: "green" },
      { title: "Energy Level", value: "78", unit: "/100", status: "Optimal", statusColor: "green" },
      { title: "Neck Swelling", value: "None", unit: "", status: "Optimal", statusColor: "green" },
    ],
  },
  liver: {
    summary: {
      title: "Liver Health",
      description:
        "Liver enzyme levels are mostly normal. One marker is slightly elevated, which can be linked to diet or recent alcohol intake — worth monitoring.",
      score: 33,
    },
    metrics: [
      { title: "ALT", value: "32", unit: "U/L", status: "Normal", statusColor: "yellow" },
      { title: "AST", value: "28", unit: "U/L", status: "Optimal", statusColor: "green" },
      { title: "Bilirubin", value: "0.8", unit: "mg/dL", status: "Optimal", statusColor: "green" },
      { title: "Albumin", value: "4.4", unit: "g/dL", status: "Optimal", statusColor: "green" },
      { title: "Fat Content", value: "Low", unit: "", status: "Optimal", statusColor: "green" },
      { title: "Detox Efficiency", value: "89", unit: "%", status: "Optimal", statusColor: "green" },
    ],
  },
  lungs: {
    summary: {
      title: "Lung Health",
      description:
        "Respiratory function is strong, with lung capacity and oxygen exchange both in a healthy range. Minor seasonal irritation noted.",
      score: 88,
    },
    metrics: [
      { title: "Lung Capacity", value: "5.1", unit: "L", status: "Optimal", statusColor: "green" },
      { title: "Respiratory Rate", value: "14", unit: "bpm", status: "Optimal", statusColor: "green" },
      { title: "Oxygen Saturation", value: "97", unit: "%", status: "Optimal", statusColor: "green" },
      { title: "Airway Irritation", value: "Mild", unit: "", status: "Normal", statusColor: "yellow" },
      { title: "FEV1", value: "92", unit: "%", status: "Optimal", statusColor: "green" },
      { title: "Cough Frequency", value: "Rare", unit: "", status: "Optimal", statusColor: "green" },
    ],
  },

  thighs: {
  summary: {
    title: "Thigh Health",
    description:
      "Lower-body strength, mobility, and muscle balance are within a healthy range. Overall thigh function supports good movement, stability, and physical performance.",
    score: 82,
  },
  metrics: [
    { title: "Muscle Strength", value: "86", unit: "/100", status: "Optimal", statusColor: "green" },
    { title: "Muscle Mass", value: "14.8", unit: "kg", status: "Optimal", statusColor: "green" },
    { title: "Flexibility", value: "91", unit: "%", status: "Optimal", statusColor: "green" },
    { title: "Left-Right Balance", value: "96", unit: "%", status: "Optimal", statusColor: "green" },
    { title: "Joint Stability", value: "88", unit: "/100", status: "Optimal", statusColor: "green" },
    { title: "Recovery Time", value: "20", unit: "hrs", status: "Normal", statusColor: "green" },
  ],
},

genitals: {
  summary: {
    title: "Reproductive Health",
    description:
      "Reproductive health indicators are within a healthy range. Current measurements suggest normal function with no significant concerns across the available markers.",
    score: 87,
  },
  metrics: [
    { title: "Hormonal Balance", value: "91", unit: "/100", status: "Optimal", statusColor: "green" },
    { title: "Circulation", value: "88", unit: "/100", status: "Optimal", statusColor: "green" },
    { title: "Testosterone", value: "620", unit: "ng/dL", status: "Optimal", statusColor: "green" },
    { title: "Fertility Index", value: "84", unit: "/100", status: "Normal", statusColor: "yellow" },
    { title: "Pelvic Health", value: "93", unit: "/100", status: "Optimal", statusColor: "green" },
    { title: "Inflammation", value: "Low", unit: "", status: "Optimal", statusColor: "green" },
  ],
},

calves: {
  summary: {
    title: "Calf Health",
    description:
      "Calf strength, circulation, and mobility are within a healthy range. Muscle condition and lower-leg function indicate good support for walking, balance, and physical activity.",
    score: 85,
  },
  metrics: [
    { title: "Muscle Strength", value: "89", unit: "/100", status: "Optimal", statusColor: "green" },
    { title: "Muscle Mass", value: "5.8", unit: "kg", status: "Optimal", statusColor: "green" },
    { title: "Circulation", value: "94", unit: "/100", status: "Optimal", statusColor: "green" },
    { title: "Flexibility", value: "87", unit: "%", status: "Normal", statusColor: "yellow" },
    { title: "Left-Right Balance", value: "97", unit: "%", status: "Optimal", statusColor: "green" },
    { title: "Recovery Time", value: "16", unit: "hrs", status: "Optimal", statusColor: "green" },
  ],
},


};

// Ring geometry -- matches the existing viewBox="0 0 60 60" circle at r=27.
const RING_RADIUS = 27;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// Segmented ring config -- change SEGMENT_COUNT to 5 or 6 as needed.
const SEGMENT_COUNT = 6;
const SEGMENT_GAP = 4; // px of gap between segments, along the circumference
const SEGMENT_LENGTH =
  (RING_CIRCUMFERENCE - SEGMENT_COUNT * SEGMENT_GAP) / SEGMENT_COUNT;
const TRACK_COLOR = "#e5e7eb";

// Turns a 0-100 score into a letter grade.
function getGradeLetter(score: number): string {
  if (score >= 85) return "S";
  if (score >= 70) return "A";
  if (score >= 55) return "B";
  if (score >= 40) return "C";
  if (score >= 25) return "D";
  if (score >= 10) return "E";
  return "F";
}

// Turns a 0-100 score into the same green/yellow/red bucket used by the
// metric rows below, so the badge stays on its own independent thresholds.
function getScoreColor(score: number): StatusColor {
  if (score >= 85) return "green";
  if (score >= 70) return "yellow";
  return "red";
}

const SCORE_HEX: Record<StatusColor, string> = {
  green: "#24bd89",
  yellow: "#eab308",
  red: "#ef4444",
};

// Letter grade -> how many of the SEGMENT_COUNT ring slots get colored in,
// and which color they're colored. This is the single source of truth for
// the ring: S = all 6 segments green, A = 5 segments green, B = 4 segments
// yellow, C = 3 segments yellow, D = 2 segments red, E = 1 segment red,
// F = 0 segments (nothing colored) with the center letter shown in red.
const GRADE_RING_CONFIG: Record<string, { segments: number; color: StatusColor }> = {
  S: { segments: 6, color: "green" },
  A: { segments: 5, color: "green" },
  B: { segments: 4, color: "yellow" },
  C: { segments: 3, color: "yellow" },
  D: { segments: 2, color: "red" },
  E: { segments: 1, color: "red" },
  F: { segments: 0, color: "red" },
};

const BADGE_STYLES: Record<StatusColor, { label: string; text: string; bg: string }> = {
  green: { label: "Optimal", text: "text-[#24bd89]", bg: "bg-[#24bd89]/10" },
  yellow: { label: "Normal", text: "text-yellow-600", bg: "bg-yellow-200/40" },
  red: { label: "Needs Attention", text: "text-red-500", bg: "bg-red-200/40" },
};

// Every body part's score, keyed the same way as healthDataByView, handed
// down to ModelScene so its sidebar buttons can each draw their own grade
// ring. Derived from healthDataByView so there's only one place the actual
// score numbers live.
const scoresByView = Object.fromEntries(
  (Object.keys(healthDataByView) as ViewKey[]).map((key) => [
    key,
    healthDataByView[key].summary.score,
  ])
) as Record<ViewKey, number>;

export default function Home() {
  const [view, setView] = useState<ViewKey>("reset");
  const healthData = healthDataByView[view];

  const statusStyles = {
    green: {
      text: "text-[#24bd89]",
      dot: "bg-[#24bd89]",
    },
    yellow: {
      text: "text-yellow-600",
      dot: "bg-yellow-500",
    },
    red: {
      text: "text-red-600",
      dot: "bg-red-500",
    },
  };

  const score = healthData.summary.score;
  const scoreColor = getScoreColor(score);
  const gradeLetter = getGradeLetter(score);
  const badge = BADGE_STYLES[scoreColor];

  // The grade letter drives both how many segments are colored in and what
  // color they use -- not the independent scoreColor badge thresholds.
  const gradeConfig = GRADE_RING_CONFIG[gradeLetter];
  const filledSegments = gradeConfig.segments;
  const gradeHex = SCORE_HEX[gradeConfig.color];

  return (
    <main className="relative flex flex-col lg:flex-row bg-[#f9f9f9]">
 
      <div className="h-10 w-fit  absolute z-999 top-0 right-0  md:left-0 mx-5 mt-5">
        <h1 className=" font-semibold text-xl md:text-2xl sm:text-3xl text-black ">Patient One</h1>

      </div>
      <ModelScene view={view} onViewChange={setView} scores={scoresByView} />
      <div className="w-full py-8 px-4 sm:py-12 sm:px-8 lg:py-20 lg:px-20 flex-col flex items-start justify-center">
        <div className="flex flex-col  justify-start mb-7 bg-white  px-4 py-2 rounded-lg w-full">
          <div className="flex w-full justify-between items-center py-1 mb-3">
          <h2 className="text-start text-xl sm:text-2xl text-black  font-medium">
            {healthData.summary.title}
          </h2>

          <h2 className={`text-sm ${badge.text} ${badge.bg}   px-3 py-1  rounded-full `}>
            ● <span className="">{badge.label}</span>
          </h2>
          </div>

          <div className="flex justify-center  items-center mb-5">
            <div className="relative w-20 h-20 flex justify-center items-center">
  <svg
    className="absolute inset-0 w-full h-full -rotate-90"
    viewBox="0 0 60 60"
  >
    {Array.from({ length: SEGMENT_COUNT }).map((_, i) => {
      const isFilled = i < filledSegments;
      return (
        <circle
          key={i}
          cx="30"
          cy="30"
          r={RING_RADIUS}
          fill="none"
          stroke={isFilled ? gradeHex : TRACK_COLOR}
          strokeWidth="3"
          strokeDasharray={`${SEGMENT_LENGTH} ${RING_CIRCUMFERENCE - SEGMENT_LENGTH}`}
          strokeDashoffset={-(i * (SEGMENT_LENGTH + SEGMENT_GAP))}
          strokeLinecap="round"
        />
      );
    })}
  </svg>

  <h2 className="text-2xl font-medium" style={{ color: gradeHex }}>
    {gradeLetter}
  </h2>
</div>
          </div>


          <p className="text-start text-md text-black/40">
            {healthData.summary.description}
          </p>
        </div>

        <div className="grid grid-cols-2 w-full px-2 justify-between">
          <div>
            <p className="text-md text-black/40">Name</p>
          </div>
          <div>
            <p className="text-md text-black/40">Status</p>
          </div>
        </div>

        <div className=" w-full  mt-2 gap-3 justify-between">
          {healthData.metrics.map((metric) => {
            const styles = statusStyles[metric.statusColor];

            return (
              <div key={metric.title} className="grid grid-cols-2 mb-2 px-4 py-2 rounded-lg bg-[#fff]">
                <div className="text-black font-medium">
                  <h3>{metric.title}</h3>

                  
                </div>

                <div className="flex flex-col">
                  <span className= {`${styles.text}`}>
                    <span
                      className={`inline-block h-1.5 w-1.5 mr-1 mb-1/2 -translate-y-1/2 rounded-full ${styles.dot}`}
                    />
                    {metric.status}
                  </span>
                  <div className="flex items-end gap-2">
                  <span className="text-black font-medium">{metric.value}</span>
                  <span className="text-black/40">{metric.unit}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}