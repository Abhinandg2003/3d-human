import ModelScene from "@/components/ModelScene";

export default function Home() {
  const healthData = {
    summary: {
      title: "Heart Health",
      description:
        "Your heart is in great condition. Your current cardiovascular indicators are within healthy ranges, suggesting strong heart function and good overall cardiovascular fitness.",
    },

    metrics: [
      {
        title: "Biological Age",
        value: "27.5",
        unit: "years",
        status: "Optimal",
        statusColor: "green",
      },
      {
        title: "Resting Heart Rate",
        value: "62",
        unit: "bpm",
        status: "Optimal",
        statusColor: "green",
      },
      {
        title: "Blood Pressure",
        value: "118/76",
        unit: "mmHg",
        status: "Optimal",
        statusColor: "green",
      },
      {
        title: "Heart Rate Variability",
        value: "58",
        unit: "ms",
        status: "Normal",
        statusColor: "yellow",
      },
      {
        title: "Blood Oxygen",
        value: "98",
        unit: "%",
        status: "Optimal",
        statusColor: "green",
      },
      {
        title: "Cardio Fitness",
        value: "46.2",
        unit: "VO₂ max",
        status: "Optimal",
        statusColor: "green",
      },
    ],
  };

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
    <main className="relative flex bg-white">
      <ModelScene />
      <div className="w-full py-20 px-20 flex-col flex items-start justify-center">
        <div className="flex flex-col  justify-start mb-7">
          <h2 className="text-start text-4xl text-black ">
            {healthData.summary.title}
          </h2>
          <p className="text-start text-lg text-black/40">
            {healthData.summary.description}
          </p>
        </div>

        <div className="grid grid-cols-2 w-full  justify-between">
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
              <div key={metric.title} className="grid grid-cols-2 mb-2 px-2 py-1 rounded-lg bg-[#eee]/40">
                <div className="text-black font-medium">
                  <h3>{metric.title}</h3>

                  
                </div>

                <div className="flex flex-col">
                  <span className= {`${styles.bg} ${styles.text}`}>
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
