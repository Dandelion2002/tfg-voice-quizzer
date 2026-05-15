// Autor:   María León Pérez
// Resumen: Pantalla de historial global de cuestionarios del usuario. Lista todos los
//          cuestionarios realizados con Alexa, ordenados del más reciente al más antiguo.
//          Cada entrada muestra asignatura, unidad, fecha, tipo de cuestionario y un
//          indicador circular SVG con el porcentaje de aciertos en verde/rojo.
import React, { useState, useEffect } from 'react';
import {
  ChevronLeft, History as HistoryIcon, Calendar, BookOpen,
  Layers, CheckCircle2, XCircle, BarChart3, Loader2,
} from 'lucide-react';
import { motion } from 'motion/react';
import { HistorialItem } from '../types';
import { dynamo } from '../lib/aws';
import Logo from './Logo';

interface HistoryProps {
  email: string;
  onBack: () => void;
}

/**
 * Recupera todo el historial de cuestionarios del usuario desde VQ_Historial
 * y lo ordena por fecha descendente (más recientes primero) usando localeCompare
 * sobre las cadenas ISO 8601, que son comparables lexicográficamente.
 */
async function fetchHistorial(email: string): Promise<HistorialItem[]> {
  const res  = await dynamo('DynamoDB_20120810.Scan', {
    TableName: 'VQ_Historial',
    FilterExpression: 'email = :e',
    ExpressionAttributeValues: { ':e': { S: email } },
  });
  const data = await res.json();
  return (data.Items ?? [])
    .map((item: any) => ({
      email:             item.email.S,
      fecha_hora:        item.fecha_hora?.S ?? '',
      nombre_asignatura: item.nombre_asignatura?.S ?? '—',
      nombre_unidad:     item.nombre_unidad?.S ?? '—',
      tipo_cuestionario: item.tipo_cuestionario?.S ?? '—',
      num_preguntas:     Number(item.num_preguntas?.N ?? 0),
      aciertos:          Number(item.aciertos?.N ?? 0),
    }))
    .sort((a, b) => b.fecha_hora.localeCompare(a.fecha_hora)); // más recientes primero
}

export default function History({ email, onBack }: HistoryProps) {
  const [historial, setHistorial] = useState<HistorialItem[]>([]);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    fetchHistorial(email)
      .then(setHistorial)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [email]);

  const renderScoreCircle = (aciertos: number, total: number) => {
    const percentage  = total > 0 ? Math.round((aciertos / total) * 100) : 0;
    const incorrectos = total - aciertos;
    const radius      = 18;
    const circumference = 2 * Math.PI * radius;
    const offset        = circumference - (percentage / 100) * circumference;

    return (
      <div className="flex items-center gap-4">
        <div className="relative w-12 h-12">
          <svg className="w-full h-full transform -rotate-90">
            <circle cx="24" cy="24" r={radius} stroke="currentColor" strokeWidth="4" fill="transparent" className="text-red-100" />
            <circle
              cx="24" cy="24" r={radius} stroke="currentColor" strokeWidth="4" fill="transparent"
              strokeDasharray={circumference} strokeDashoffset={offset}
              strokeLinecap="round"
              className="text-emerald-500 transition-all duration-1000 ease-out"
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[10px] font-bold text-gray-700">{percentage}%</span>
          </div>
        </div>
        <div className="flex flex-col">
          <div className="flex items-center gap-1 text-emerald-600">
            <CheckCircle2 className="w-3 h-3" /><span className="text-[10px] font-bold">{aciertos}</span>
          </div>
          <div className="flex items-center gap-1 text-red-500">
            <XCircle className="w-3 h-3" /><span className="text-[10px] font-bold">{incorrectos}</span>
          </div>
        </div>
      </div>
    );
  };

  const formatFecha = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('es-ES', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch { return iso; }
  };

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
              <HistoryIcon className="w-6 h-6 text-tepro-orange" />
              <h1 className="text-xl font-bold text-gray-900">Historial de Cuestionarios</h1>
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
              <HistoryIcon className="w-10 h-10 text-gray-300" />
            </div>
            <h3 className="text-lg font-bold text-gray-900 mb-2">No hay historial</h3>
            <p className="text-gray-500">Aún no has completado ningún cuestionario con Alexa.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {historial.map((item, index) => (
              <motion.div
                key={`${item.fecha_hora}-${index}`}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-6"
              >
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-1">
                      <BookOpen className="w-3 h-3" /> Asignatura
                    </p>
                    <p className="text-sm font-bold text-gray-800">{item.nombre_asignatura}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-1">
                      <Layers className="w-3 h-3" /> Unidad
                    </p>
                    <p className="text-sm font-semibold text-gray-600">{item.nombre_unidad}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-1">
                      <Calendar className="w-3 h-3" /> Fecha
                    </p>
                    <p className="text-sm text-gray-500">{formatFecha(item.fecha_hora)}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-1">
                      <BarChart3 className="w-3 h-3" /> Tipo / Preguntas
                    </p>
                    <p className="text-sm text-gray-500">
                      <span className="font-medium text-tepro-orange">{item.tipo_cuestionario}</span> • {item.num_preguntas} preg.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-6 border-t md:border-t-0 md:border-l border-gray-100 pt-4 md:pt-0 md:pl-6">
                  {renderScoreCircle(item.aciertos, item.num_preguntas)}
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
