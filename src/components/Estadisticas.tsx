// Autor:   María León Pérez
// Resumen: Pantalla de estadísticas de progreso para una unidad concreta. Muestra un
//          gráfico de área (Recharts) con la evolución del porcentaje de aciertos en
//          orden cronológico, y tres métricas resumen: media, mejor resultado y total
//          de cuestionarios. Incluye un indicador visual (verde/rojo) según si el último
//          resultado supera el 70% de aciertos.
import React, { useState, useEffect } from 'react';
import { ChevronLeft, BarChart3, TrendingUp, TrendingDown, Loader2 } from 'lucide-react';
import { motion } from 'motion/react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Unidad, HistorialItem } from '../types';
import { dynamo } from '../lib/aws';

interface EstadisticasProps {
  email: string;
  unidad: Unidad;
  onBack: () => void;
}

interface DataPoint {
  date: string;
  fullLabel: string;
  percentage: number;
  tipo: string;
  aciertos: number;
  total: number;
}

/**
 * Recupera el historial de cuestionarios de una unidad específica con un Scan de
 * VQ_Historial filtrando por email, asignatura y unidad. Los resultados se ordenan
 * cronológicamente (ascendente) para que el gráfico de área muestre la progresión
 * temporal de izquierda a derecha.
 */
async function fetchHistorialUnidad(
  email: string,
  nombre_asignatura: string,
  nombre_unidad: string
): Promise<HistorialItem[]> {
  const res  = await dynamo('DynamoDB_20120810.Scan', {
    TableName: 'VQ_Historial',
    FilterExpression: 'email = :e AND nombre_asignatura = :a AND nombre_unidad = :u',
    ExpressionAttributeValues: {
      ':e': { S: email },
      ':a': { S: nombre_asignatura },
      ':u': { S: nombre_unidad },
    },
  });
  const data = await res.json();
  return (data.Items ?? [])
    .map((item: any) => ({
      email:             item.email.S,
      fecha_hora:        item.fecha_hora?.S ?? '',
      nombre_asignatura: item.nombre_asignatura?.S ?? '',
      nombre_unidad:     item.nombre_unidad?.S ?? '',
      tipo_cuestionario: item.tipo_cuestionario?.S ?? '',
      num_preguntas:     Number(item.num_preguntas?.N ?? 0),
      aciertos:          Number(item.aciertos?.N ?? 0),
    }))
    .sort((a, b) => a.fecha_hora.localeCompare(b.fecha_hora)); // cronológico para la gráfica
}

export default function Estadisticas({ email, unidad, onBack }: EstadisticasProps) {
  const [historial, setHistorial] = useState<HistorialItem[]>([]);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    fetchHistorialUnidad(email, unidad.nombre_asignatura, unidad.nombre_unidad)
      .then(setHistorial)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [email, unidad]);

  const chartData: DataPoint[] = historial.map((item, idx) => ({
    date: `#${idx + 1} ${new Date(item.fecha_hora).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })}`,
    fullLabel: new Date(item.fecha_hora).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
    percentage: item.num_preguntas > 0 ? Math.round((item.aciertos / item.num_preguntas) * 100) : 0,
    tipo: item.tipo_cuestionario,
    aciertos: item.aciertos,
    total: item.num_preguntas,
  }));

  const lastPercentage  = chartData.length > 0 ? chartData[chartData.length - 1].percentage : 0;
  const mediaAciertos   = chartData.length > 0
    ? Math.round(chartData.reduce((acc, d) => acc + d.percentage, 0) / chartData.length)
    : 0;
  const mejorResultado  = chartData.length > 0 ? Math.max(...chartData.map(d => d.percentage)) : 0;
  const isDoingWell     = lastPercentage >= 70;

  return (
    <div className="min-h-screen bg-tepro-gray">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-8 py-4 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={onBack} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
              <ChevronLeft className="w-5 h-5 text-gray-500" />
            </button>
            <div className="flex items-center gap-2">
              <BarChart3 className="w-6 h-6 text-tepro-orange" />
              <div>
                <h1 className="text-xl font-bold text-gray-900">{unidad.nombre_unidad}</h1>
                <p className="text-xs text-gray-400">{unidad.nombre_asignatura}</p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-8 py-12">
        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="w-8 h-8 text-tepro-orange animate-spin" />
          </div>
        ) : historial.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-20 h-20 bg-gray-50 rounded-3xl flex items-center justify-center mx-auto mb-4">
              <BarChart3 className="w-10 h-10 text-gray-300" />
            </div>
            <h3 className="text-lg font-bold text-gray-900 mb-2">Sin datos todavía</h3>
            <p className="text-gray-500">Completa cuestionarios con Alexa para ver tus estadísticas aquí.</p>
          </div>
        ) : (
          <>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100"
            >
              <div className="mb-8">
                <h2 className="text-lg font-bold text-gray-900 mb-2">Progreso de Aciertos</h2>
                <p className="text-sm text-gray-500">Evolución del porcentaje de aciertos en los últimos cuestionarios.</p>
              </div>

              <div className="h-[400px] w-full mb-12">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="colorPct" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#F27D26" stopOpacity={0.1} />
                        <stop offset="95%" stopColor="#F27D26" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                    <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#9ca3af' }} dy={10} />
                    <YAxis domain={[0, 100]} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#9ca3af' }} dx={-10} tickFormatter={(v) => `${v}%`} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#fff', borderRadius: '12px', border: '1px solid #f3f4f6', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                      formatter={(value: number, _name: string, props: any) => {
                        const d = props.payload;
                        return [`${value}% (${d.aciertos}/${d.total} correctas)`, d.tipo === 'test' ? 'Test' : 'Desarrollo'];
                      }}
                      labelFormatter={(_label: string, payload: any[]) => {
                        if (payload && payload[0]) return payload[0].payload.fullLabel;
                        return _label;
                      }}
                    />
                    <Area type="monotone" dataKey="percentage" stroke="#F27D26" strokeWidth={3} fillOpacity={1} fill="url(#colorPct)" activeDot={{ r: 6, strokeWidth: 0, fill: '#F27D26' }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className={`p-6 rounded-2xl border flex items-center gap-4 ${isDoingWell ? 'bg-emerald-50 border-emerald-100 text-emerald-800' : 'bg-red-50 border-red-100 text-red-800'}`}>
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${isDoingWell ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white'}`}>
                  {isDoingWell ? <TrendingUp className="w-6 h-6" /> : <TrendingDown className="w-6 h-6" />}
                </div>
                <div>
                  <h3 className="font-bold text-lg">
                    {isDoingWell ? '¡Vas por muy buen camino!' : 'Necesitas repasar un poco más'}
                  </h3>
                  <p className="text-sm opacity-80">
                    Tu último porcentaje de aciertos fue del <span className="font-bold">{lastPercentage}%</span>.{' '}
                    {isDoingWell
                      ? 'Sigue así para dominar completamente esta unidad.'
                      : 'Intenta revisar los materiales de la unidad antes del próximo cuestionario.'}
                  </p>
                </div>
              </div>
            </motion.div>

            <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Media de Aciertos</p>
                <p className="text-2xl font-bold text-gray-900">{mediaAciertos}%</p>
              </div>
              <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Mejor Resultado</p>
                <p className="text-2xl font-bold text-emerald-600">{mejorResultado}%</p>
              </div>
              <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Cuestionarios Realizados</p>
                <p className="text-2xl font-bold text-gray-900">{historial.length}</p>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
