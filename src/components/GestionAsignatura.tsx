// Autor:   María León Pérez
// Resumen: Pantalla de gestión de una asignatura. Permite editar la descripción e icono,
//          ver y gestionar todas las unidades (crear, editar, eliminar, ver estadísticas)
//          y ver el resumen generado por Alexa en un modal con opción de exportar a PDF
//          usando jsPDF. La eliminación de asignatura borra en cascada todas las unidades
//          y sus archivos en S3 mediante Promise.allSettled (best-effort, no aborta si
//          algún archivo S3 ya no existe).
import React, { useState, useEffect } from 'react';
import {
  LayoutDashboard, Plus, RefreshCw, Trash2, Edit3, ChevronLeft,
  FileText, Save, Search, BarChart3, Loader2, AlertTriangle,
  BookOpen, X, FileDown,
} from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Asignatura, Unidad } from '../types';
import { dynamo, s3Delete } from '../lib/aws';
import Logo from './Logo';

const SUBJECT_ICONS = [
  'Calculator', 'Pi', 'Divide', 'Plus', 'History', 'Scroll', 'Landmark', 'Hourglass',
  'Globe', 'Map', 'Compass', 'Mountain', 'FlaskConical', 'Atom', 'Microscope', 'Dna',
  'Book', 'Languages', 'PenTool', 'Type', 'Palette', 'Music', 'Theater', 'GraduationCap',
  'School', 'Library', 'Brain',
];

interface GestionAsignaturaProps {
  email: string;
  asignatura: Asignatura;
  onAsignaturaUpdated: (updated: Asignatura) => void;
  onAsignaturaDeleted: () => void;
  onBack: () => void;
  onLogout: () => void;
  onEditUnidad: (unidad: Unidad) => void;
  onCreateUnidad: () => void;
  onViewStats: (unidad: Unidad) => void;
}

// ── DynamoDB helpers ──────────────────────────────────────────────────────────

/** Recupera todas las unidades de una asignatura desde VQ_Unidad. */
async function fetchUnidades(email: string, nombre_asignatura: string): Promise<Unidad[]> {
  const res  = await dynamo('DynamoDB_20120810.Scan', {
    TableName: 'VQ_Unidad',
    FilterExpression: 'email = :e AND nombre_asignatura = :a',
    ExpressionAttributeValues: {
      ':e': { S: email },
      ':a': { S: nombre_asignatura },
    },
  });
  const data = await res.json();
  return (data.Items ?? []).map((item: any) => ({
    email:               item.email.S,
    detalle_archivo:     item.detalle_archivo.S,
    nombre_asignatura:   item.nombre_asignatura.S,
    nombre_unidad:       item.nombre_unidad.S,
    descripcion:         item.descripcion?.S ?? '',
    fecha_creacion:      item.fecha_creacion?.S ?? '',
    fecha_actualizacion: item.fecha_actualizacion?.S ?? '',
    estado:              (item.estado?.S ?? 'pendiente') as 'pendiente' | 'listo',
    ruta_s3:             item.ruta_s3?.S ?? '',
    tipo_archivo:        (item.tipo_archivo?.S ?? 'PDF') as Unidad['tipo_archivo'],
    nombre_archivo:      item.nombre_archivo?.S ?? '',
    resumen:             item.resumen?.S ?? '',
  }));
}

async function updateAsignatura(asignatura: Asignatura): Promise<{ error?: string }> {
  const id  = `${asignatura.email}#${asignatura.nombre_asignatura}`;
  const res = await dynamo('DynamoDB_20120810.PutItem', {
    TableName: 'VQ_Asignatura',
    Item: {
      id_asignatura:     { S: id },
      email:             { S: asignatura.email },
      nombre_asignatura: { S: asignatura.nombre_asignatura },
      descripcion:       { S: asignatura.descripcion },
      icono:             { S: asignatura.icono },
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error('DynamoDB updateAsignatura error:', body);
    return { error: body.message ?? 'Error guardando los cambios.' };
  }
  return {};
}

async function deleteUnidadS3(unidad: Unidad): Promise<void> {
  if (!unidad.nombre_archivo) return;
  const fileKey = `${unidad.email}/${unidad.nombre_asignatura}/${unidad.nombre_unidad}/${
    unidad.tipo_archivo === 'URL' ? 'source.txt' : unidad.nombre_archivo
  }`;
  await s3Delete(fileKey).catch(() => {}); // best-effort
}

async function deleteUnidad(unidad: Unidad): Promise<void> {
  await deleteUnidadS3(unidad);
  const id = `${unidad.email}#${unidad.nombre_asignatura}#${unidad.nombre_unidad}`;
  await dynamo('DynamoDB_20120810.DeleteItem', {
    TableName: 'VQ_Unidad',
    Key: {
      id_unidad:       { S: id },
      detalle_archivo: { S: unidad.detalle_archivo },
    },
  });
}

/**
 * Elimina la asignatura en cascada: primero borra el archivo S3 y el registro DynamoDB
 * de cada unidad con Promise.allSettled (los errores individuales no detienen el proceso),
 * y después borra el registro de la propia asignatura en VQ_Asignatura.
 */
async function deleteAsignatura(
  email: string,
  nombre_asignatura: string,
  unidades: Unidad[]
): Promise<void> {
  // 1. Eliminar archivos S3 y registros DynamoDB de cada unidad
  await Promise.allSettled(unidades.map(u => deleteUnidad(u)));
  // 2. Eliminar la asignatura
  const id = `${email}#${nombre_asignatura}`;
  await dynamo('DynamoDB_20120810.DeleteItem', {
    TableName: 'VQ_Asignatura',
    Key: { id_asignatura: { S: id } },
  });
}

// ── Componente ────────────────────────────────────────────────────────────────

export default function GestionAsignatura({
  email, asignatura, onAsignaturaUpdated, onAsignaturaDeleted,
  onBack, onLogout, onEditUnidad, onCreateUnidad, onViewStats,
}: GestionAsignaturaProps) {
  const [unidades, setUnidades]       = useState<Unidad[]>([]);
  const [loadingUnidades, setLoadingUnidades] = useState(true);
  const [asignaturaName, setAsignaturaName]   = useState(asignatura.nombre_asignatura);
  const [asignaturaDesc, setAsignaturaDesc]   = useState(asignatura.descripcion);
  const [selectedIcon, setSelectedIcon]       = useState(asignatura.icono);
  const [iconSearch, setIconSearch]           = useState('');
  const [saving, setSaving]                     = useState(false);
  const [saveError, setSaveError]               = useState('');
  const [showDeleteAsig, setShowDeleteAsig]     = useState(false);
  const [deletingAsig, setDeletingAsig]         = useState(false);
  const [unidadToDelete, setUnidadToDelete]     = useState<Unidad | null>(null);
  const [deletingUnidad, setDeletingUnidad]     = useState(false);
  const [resumenModal, setResumenModal]         = useState<Unidad | null>(null);

  const loadUnidades = () => {
    setLoadingUnidades(true);
    fetchUnidades(email, asignatura.nombre_asignatura)
      .then(setUnidades)
      .catch(() => {})
      .finally(() => setLoadingUnidades(false));
  };

  useEffect(() => { loadUnidades(); }, [email, asignatura.nombre_asignatura]);

  const renderIcon = (iconName: string, className = 'w-5 h-5') => {
    const IconComponent = (LucideIcons as any)[iconName];
    return IconComponent ? <IconComponent className={className} /> : <FileText className={className} />;
  };

  const filteredIcons = SUBJECT_ICONS.filter(n => n.toLowerCase().includes(iconSearch.toLowerCase()));

  const handleUpdateAsignatura = async () => {
    setSaveError('');
    setSaving(true);
    try {
      const updated: Asignatura = {
        email,
        nombre_asignatura: asignatura.nombre_asignatura,
        descripcion: asignaturaDesc.trim(),
        icono: selectedIcon,
      };
      const result = await updateAsignatura(updated);
      if (result.error) { setSaveError(result.error); return; }
      onAsignaturaUpdated(updated);
    } catch {
      setSaveError('Error guardando los cambios.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAsignatura = async () => {
    setDeletingAsig(true);
    try {
      await deleteAsignatura(email, asignatura.nombre_asignatura, unidades);
      setShowDeleteAsig(false);
      onAsignaturaDeleted();
    } catch {
      setSaveError('Error eliminando la asignatura.');
    } finally {
      setDeletingAsig(false);
    }
  };

  const handleDeleteUnidad = async () => {
    if (!unidadToDelete) return;
    setDeletingUnidad(true);
    try {
      await deleteUnidad(unidadToDelete);
      setUnidades(prev => prev.filter(u => u.detalle_archivo !== unidadToDelete.detalle_archivo));
      setUnidadToDelete(null);
    } catch {
      setSaveError('Error eliminando la unidad.');
      setUnidadToDelete(null);
    } finally {
      setDeletingUnidad(false);
    }
  };

  /**
   * Genera un PDF del resumen de la unidad con jsPDF y lo abre en una nueva pestaña.
   * jsPDF se importa dinámicamente (lazy import) para no incluirlo en el bundle inicial.
   * El texto del resumen se divide por párrafos ('\n\n') y cada uno se ajusta al ancho
   * de página con splitTextToSize. Salta de página automáticamente si no cabe el párrafo.
   */
  const exportarPDF = async (unidad: Unidad) => {
    const { jsPDF } = await import('jspdf');

    const doc      = new jsPDF({ unit: 'mm', format: 'a4' });
    const mX       = 20;          // margen horizontal
    const anchoUtil = 170;        // 210 - 2*20
    const altoPag  = 280;         // altura útil antes de saltar de página
    let y = 22;

    // ── Cabecera ──────────────────────────────────────────────────────
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(30, 30, 30);
    doc.text(unidad.nombre_asignatura, mX, y);
    y += 7;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(80, 80, 80);
    doc.text(unidad.nombre_unidad, mX, y);
    y += 5;

    if (unidad.descripcion) {
      doc.setFontSize(9);
      doc.setTextColor(140, 140, 140);
      const descLineas = doc.splitTextToSize(unidad.descripcion, anchoUtil);
      doc.text(descLineas, mX, y);
      y += descLineas.length * 4 + 2;
    }

    // línea naranja separadora
    doc.setDrawColor(232, 76, 14);
    doc.setLineWidth(0.5);
    doc.line(mX, y, 210 - mX, y);
    y += 9;

    // ── Cuerpo del resumen ────────────────────────────────────────────
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(30, 30, 30);

    const parrafos = (unidad.resumen || '').split('\n\n').filter(Boolean);
    for (const parrafo of parrafos) {
      const lineas = doc.splitTextToSize(parrafo.replace(/\n/g, ' '), anchoUtil);
      if (y + lineas.length * 5.5 > altoPag) {
        doc.addPage();
        y = 20;
      }
      doc.text(lineas, mX, y);
      y += lineas.length * 5.5 + 4;
    }

    // ── Abrir PDF en nueva pestaña ────────────────────────────────────
    const blob = doc.output('blob');
    const url  = URL.createObjectURL(blob);
    window.open(url, '_blank');
  };

  const estadoBadge = (estado: Unidad['estado']) =>
    estado === 'listo'
      ? <><div className="w-2 h-2 bg-emerald-500 rounded-full" /><span className="text-xs font-medium text-emerald-600">Listo</span></>
      : <><div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" /><span className="text-xs font-medium text-amber-600">Pendiente</span></>;

  return (
    <div className="min-h-screen bg-tepro-gray">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-8 py-4 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={onBack} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
              <ChevronLeft className="w-5 h-5 text-gray-500" />
            </button>
            <Logo className="w-10 h-10" onClick={onBack} />
            <div className="flex items-center gap-2">
              <LayoutDashboard className="w-6 h-6 text-tepro-orange" />
              <h1 className="text-xl font-bold text-gray-900">{asignatura.nombre_asignatura}</h1>
            </div>
          </div>
          <button
            onClick={() => setShowDeleteAsig(true)}
            className="flex items-center gap-2 px-4 py-2 text-red-500 border border-red-200 hover:bg-red-50 rounded-xl font-bold text-sm transition-all"
          >
            <Trash2 className="w-4 h-4" />
            Eliminar Asignatura
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-8 py-12">
        {/* Stats */}
        <div className="grid grid-cols-1 gap-6 mb-8">
          <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
            <p className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">Total Unidades</p>
            <p className="text-3xl font-bold text-gray-900">{unidades.length}</p>
          </div>
        </div>

        {/* Asignatura Details Edit */}
        <div className="bg-white p-8 rounded-2xl border border-gray-100 shadow-sm mb-8">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Edit3 className="w-5 h-5 text-tepro-orange" />
              Detalles de la Asignatura
            </h2>
            <div className="flex items-center gap-3">
              {saveError && <p className="text-xs text-red-500 font-bold">{saveError}</p>}
              <button
                onClick={handleUpdateAsignatura}
                disabled={saving}
                className="flex items-center gap-2 px-6 py-2 bg-tepro-orange text-white rounded-xl font-bold hover:bg-orange-700 transition-all shadow-md active:scale-95 text-sm disabled:opacity-60"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {saving ? 'Guardando...' : 'Guardar Cambios'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Nombre de la Asignatura</label>
                <input
                  type="text"
                  value={asignaturaName}
                  disabled
                  title="El nombre no se puede cambiar una vez creada la asignatura."
                  className="w-full px-4 py-3 bg-gray-100 border border-gray-200 rounded-xl font-medium text-gray-500 cursor-not-allowed"
                />
                <p className="text-[10px] text-gray-400">El nombre identifica la asignatura y no puede modificarse.</p>
              </div>
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Descripción</label>
                <textarea
                  rows={4}
                  value={asignaturaDesc}
                  onChange={(e) => setAsignaturaDesc(e.target.value)}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-tepro-orange transition-all font-medium resize-none"
                  placeholder="Breve descripción de la asignatura..."
                />
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-gray-400 uppercase tracking-widest">Icono de la Asignatura</label>
                <div className="flex items-center gap-2 px-3 py-1 bg-orange-50 rounded-lg">
                  {renderIcon(selectedIcon, 'w-4 h-4 text-tepro-orange')}
                </div>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Buscar icono..."
                  value={iconSearch}
                  onChange={(e) => setIconSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-tepro-orange/20 focus:border-tepro-orange"
                />
              </div>
              <div className="grid grid-cols-5 gap-2 max-h-48 overflow-y-auto p-1 scrollbar-thin scrollbar-thumb-gray-200 border border-gray-100 rounded-xl bg-gray-50/50">
                {filteredIcons.map((iconName) => (
                  <button
                    key={iconName}
                    onClick={() => setSelectedIcon(iconName)}
                    title={iconName}
                    className={`flex flex-col items-center justify-center p-2 rounded-lg border-2 transition-all ${
                      selectedIcon === iconName
                        ? 'border-tepro-orange bg-white text-tepro-orange shadow-sm'
                        : 'border-transparent text-gray-400 hover:bg-white hover:text-gray-600'
                    }`}
                  >
                    {renderIcon(iconName, 'w-5 h-5')}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Create Button */}
        <div className="flex justify-center mb-12">
          <button
            onClick={onCreateUnidad}
            className="flex items-center gap-2 px-8 py-4 bg-white border-2 border-tepro-orange text-tepro-orange rounded-2xl font-bold hover:bg-orange-50 transition-all shadow-sm active:scale-95"
          >
            <Plus className="w-5 h-5" />
            Añadir Unidad
          </button>
        </div>

        {/* Units Table */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
            <h2 className="font-bold text-gray-800">Unidades de la Asignatura</h2>
            <button
              onClick={loadUnidades}
              className="text-xs font-bold text-tepro-orange hover:underline flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" />
              Actualizar
            </button>
          </div>

          <div className="overflow-x-auto">
            {loadingUnidades ? (
              <div className="flex justify-center py-12">
                <Loader2 className="w-6 h-6 text-tepro-orange animate-spin" />
              </div>
            ) : unidades.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-gray-400 text-sm italic">No hay unidades creadas todavía.</p>
              </div>
            ) : (
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-gray-50/50">
                    <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Nombre</th>
                    <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Tipo</th>
                    <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Actualización</th>
                    <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest">Estado RAG</th>
                    <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-widest text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {unidades.map((unidad) => (
                    <motion.tr
                      key={unidad.detalle_archivo}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="hover:bg-gray-50/50 transition-colors"
                    >
                      <td className="px-6 py-4">
                        <p className="font-semibold text-gray-800">{unidad.nombre_unidad}</p>
                        <p className="text-xs text-gray-400">{unidad.descripcion}</p>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2 py-1 rounded-lg">
                          {unidad.tipo_archivo}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className="text-sm text-gray-500">
                          {unidad.fecha_actualizacion?.slice(0, 10) || '—'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          {estadoBadge(unidad.estado)}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {unidad.resumen && (
                            <button
                              onClick={() => setResumenModal(unidad)}
                              className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                              title="Ver resumen"
                            >
                              <BookOpen className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            onClick={() => onViewStats(unidad)}
                            className="p-2 text-gray-400 hover:text-tepro-orange hover:bg-orange-50 rounded-lg transition-all"
                            title="Estadísticas"
                          >
                            <BarChart3 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => onEditUnidad(unidad)}
                            className="p-2 text-gray-400 hover:text-tepro-orange hover:bg-orange-50 rounded-lg transition-all"
                            title="Editar"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setUnidadToDelete(unidad)}
                            className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                            title="Eliminar"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </main>

      {/* Modal resumen */}
      <AnimatePresence>
        {resumenModal && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100] p-6">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full max-h-[82vh] flex flex-col"
            >
              {/* Cabecera */}
              <div className="px-8 py-6 border-b border-gray-100 flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-bold text-tepro-orange uppercase tracking-widest mb-1">
                    Resumen generado por Alexa
                  </p>
                  <h3 className="text-xl font-bold text-gray-900">{resumenModal.nombre_unidad}</h3>
                  {resumenModal.descripcion && (
                    <p className="text-sm text-gray-500 mt-1">{resumenModal.descripcion}</p>
                  )}
                </div>
                <button
                  onClick={() => setResumenModal(null)}
                  className="p-2 hover:bg-gray-100 rounded-full transition-colors flex-shrink-0"
                >
                  <X className="w-5 h-5 text-gray-400" />
                </button>
              </div>

              {/* Contenido */}
              <div className="px-8 py-6 overflow-y-auto flex-1">
                {(resumenModal.resumen || '').split('\n\n').map((parrafo, i) => (
                  <p key={i} className="text-gray-700 leading-relaxed mb-4 text-sm">
                    {parrafo}
                  </p>
                ))}
              </div>

              {/* Pie */}
              <div className="px-8 py-4 border-t border-gray-100 flex justify-end">
                <button
                  onClick={() => exportarPDF(resumenModal)}
                  className="flex items-center gap-2 px-6 py-2 bg-tepro-orange text-white rounded-xl font-bold hover:bg-orange-700 transition-all shadow-md active:scale-95 text-sm"
                >
                  <FileDown className="w-4 h-4" />
                  Exportar a PDF
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Modal confirmación borrar unidad */}
      <AnimatePresence>
        {unidadToDelete && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100] p-6">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8"
            >
              <div className="w-16 h-16 bg-red-50 rounded-2xl flex items-center justify-center mb-6">
                <AlertTriangle className="w-8 h-8 text-red-600" />
              </div>
              <h3 className="text-2xl font-bold text-gray-900 mb-2">¿Eliminar unidad?</h3>
              <p className="text-gray-500 text-sm mb-2 leading-relaxed">
                Vas a eliminar <span className="font-bold text-gray-800">{unidadToDelete.nombre_unidad}</span> y su archivo en S3.
              </p>
              <p className="text-red-500 text-xs font-medium mb-8">
                Esta acción no se puede revertir.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setUnidadToDelete(null)}
                  disabled={deletingUnidad}
                  className="flex-1 py-3 bg-gray-50 text-gray-600 rounded-xl font-bold hover:bg-gray-100 transition-all disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleDeleteUnidad}
                  disabled={deletingUnidad}
                  className="flex-1 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-all shadow-md disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {deletingUnidad && <Loader2 className="w-4 h-4 animate-spin" />}
                  {deletingUnidad ? 'Eliminando...' : 'Eliminar'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Modal confirmación borrar asignatura */}
      <AnimatePresence>
        {showDeleteAsig && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100] p-6">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8"
            >
              <div className="w-16 h-16 bg-red-50 rounded-2xl flex items-center justify-center mb-6">
                <AlertTriangle className="w-8 h-8 text-red-600" />
              </div>
              <h3 className="text-2xl font-bold text-gray-900 mb-2">¿Eliminar asignatura?</h3>
              <p className="text-gray-500 text-sm mb-2 leading-relaxed">
                Vas a eliminar <span className="font-bold text-gray-800">{asignatura.nombre_asignatura}</span> junto con todas sus unidades y archivos en S3.
              </p>
              <p className="text-red-500 text-xs font-medium mb-8">
                Esta acción no se puede revertir.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowDeleteAsig(false)}
                  disabled={deletingAsig}
                  className="flex-1 py-3 bg-gray-50 text-gray-600 rounded-xl font-bold hover:bg-gray-100 transition-all disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleDeleteAsignatura}
                  disabled={deletingAsig}
                  className="flex-1 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-all shadow-md disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {deletingAsig && <Loader2 className="w-4 h-4 animate-spin" />}
                  {deletingAsig ? 'Eliminando...' : 'Eliminar'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
