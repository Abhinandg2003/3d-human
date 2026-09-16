"use client";

import { useState } from "react";
import ModelScene, { type ViewKey } from "@/components/ModelScene";

type StatusColor = "green" | "yellow" | "red";

interface HealthPanelData {
  summary: {
    title: string;
    description: string;
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
};

export default function Home() {
  const [view, setView] = useState<ViewKey>("reset");
  const healthData = healthDataByView[view];

  const statusStyles = {
    green: {
      text: "text-green-600",
      dot: "bg-green-500",
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

  return (
    <main className="relative flex bg-[#f9f9f9]">
 
      <div className="h-10 w-fit  absolute z-999 top-0  left-0 ml-5 mt-5">
        <h1 className=" font-semibold text-3xl text-black ">Patient One</h1>

      </div>
      <ModelScene view={view} onViewChange={setView} />
      <div className="w-full py-20 px-20 flex-col flex items-start justify-center">
        <div className="flex flex-col  justify-start mb-7 bg-white  px-4 py-2 rounded-lg ">
          <div className="flex w-full justify-between items-center py-1 mb-3">
          <h2 className="text-start text-2xl text-black  font-medium">
            {healthData.summary.title}
          </h2>

          <h2 className="text-sm text-green-500 bg-green-200/40   px-3 py-1  rounded-full ">
            ● <span className="">Optimal</span>
          </h2>
          </div>

          <div className="flex justify-center  items-center mb-5">
            <div className="relative w-20 h-20 flex justify-center items-center">
  <svg
    className="absolute inset-0 w-full h-full -rotate-90"
    viewBox="0 0 60 60"
  >
    <circle
      cx="30"
      cy="30"
      r="27"
      fill="none"
      stroke="#22c55e"
      strokeWidth="3"
      strokeDasharray="23 5"
      strokeLinecap="round"
    />
  </svg>

  <h2 className="text-green-500 text-2xl font-medium">F</h2>
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