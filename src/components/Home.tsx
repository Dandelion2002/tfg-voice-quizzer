import React, { useState, useRef, useEffect } from 'react';
import { Search, ArrowRight, User, Settings, History, LogOut, Plus, X, Loader2 } from 'lucide-react';
import * as LucideIcons from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Asignatura } from '../types';
import { dynamo } from '../lib/aws';
import Logo from './Logo';

interface HomeProps {
  email: string;
  pin: string;
  fotoKey?: string;
  onSelectAsignatura: (asignatura: Asignatura) => void;
  onGoToHistory: () => void;
  onViewUser: () => void;
  onLogout: () => void;
}

const AVAILABLE_ICONS = [
  'Book', 'GraduationCap', 'Brain', 'Microscope', 'Calculator', 'Pi', 'Divide',
  'History', 'Scroll', 'Landmark', 'Hourglass', 'Globe', 'Map', 'Compass',
  'Mountain', 'FlaskConical', 'Atom', 'Dna', 'Languages', 'PenTool', 'Type',
  'Palette', 'Music', 'Theater', 'School', 'Library', 'BarChart3',
];

// ── DynamoDB helpers ──────────────────────────────────────────────────────────

async function fetchAsignaturas(email: string): Promise<Asignatura[]> {
  const res  = await dynamo('DynamoDB_20120810.Scan', {
    TableName: 'VQ_Asignatura',
    FilterExpression: 'email = :e',
    ExpressionAttributeValues: { ':e': { S: email } },
  });
  const data = await res.json();
  return (data.Items ?? []).map((item: any) => ({
    email:             item.email.S,
    nombre_asignatura: item.nombre_asignatura.S,
    descripcion:       item.descripcion?.S ?? '',
    icono:             item.icono?.S ?? 'Book',
  }));
}

async function crearAsignatura(asignatura: Asignatura): Promise<{ error?: string }> {
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
    ConditionExpression: 'attribute_not_exists(id_asignatura)',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (body.__type?.includes('ConditionalCheckFailed')) {
      return { error: 'Ya existe una asignatura con ese nombre.' };
    }
    return { error: 'Error creando la asignatura. Inténtalo de nuevo.' };
  }
  return {};
}

// ── Componente ────────────────────────────────────────────────────────────────

export default function Home({ email, pin, onSelectAsignatura, onGoToHistory, onViewUser, onLogout }: HomeProps) {
  const [asignaturas, setAsignaturas]       = useState<Asignatura[]>([]);
  const [loading, setLoading]               = useState(true);
  const [searchQuery, setSearchQuery]       = useState('');
  const [showUserMenu, setShowUserMenu]     = useState(false);
  const [showCreatePopup, setShowCreatePopup] = useState(false);
  const [newAsignatura, setNewAsignatura]   = useState({ name: '', description: '', icon: 'Book' });
  const [creating, setCreating]             = useState(false);
  const [createError, setCreateError]       = useState('');

  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchAsignaturas(email)
      .then(setAsignaturas)
      .catch(() => {/* error silencioso, la lista queda vacía */})
      .finally(() => setLoading(false));
  }, [email]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filtered = asignaturas.filter(a =>
    a.nombre_asignatura.toLowerCase().includes(searchQuery.toLowerCase()) ||
    a.descripcion.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const getIcon = (iconName: string, className?: string) => {
    const IconComponent = (LucideIcons as any)[iconName];
    if (!IconComponent) return <LucideIcons.FileText className={className || 'w-6 h-6 text-tepro-orange'} />;
    return <IconComponent className={className || 'w-6 h-6 text-tepro-orange'} />;
  };

  const handleCreateAsignatura = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError('');
    setCreating(true);
    try {
      const nueva: Asignatura = {
        email,
        nombre_asignatura: newAsignatura.name.trim(),
        descripcion:        newAsignatura.description.trim(),
        icono:              newAsignatura.icon,
      };
      const result = await crearAsignatura(nueva);
      if (result.error) { setCreateError(result.error); return; }
      setAsignaturas(prev => [...prev, nueva]);
      setShowCreatePopup(false);
      setNewAsignatura({ name: '', description: '', icon: 'Book' });
    } catch {
      setCreateError('Error creando la asignatura. Inténtalo de nuevo.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="flex items-center justify-between px-8 py-4 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <Logo className="w-10 h-10" />
          <span className="font-bold text-xl tracking-tight text-tepro-orange">Voice Quizzer</span>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={onGoToHistory}
            className="flex items-center gap-2 px-4 py-2 text-gray-400 hover:text-tepro-orange hover:bg-orange-50 rounded-xl transition-all font-semibold text-sm"
          >
            <History className="w-4 h-4" />
            Historial
          </button>

          <div className="relative" ref={userMenuRef}>
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="w-10 h-10 bg-orange-50 rounded-full flex items-center justify-center border-2 border-transparent hover:border-tepro-orange transition-all"
            >
              <User className="w-5 h-5 text-tepro-orange" />
            </button>

            <AnimatePresence>
              {showUserMenu && (
                <motion.div
                  initial={{ opacity: 0, y: 10, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 10, scale: 0.95 }}
                  className="absolute right-0 mt-2 w-56 bg-white rounded-2xl shadow-xl border border-gray-100 py-2 z-50"
                >
                  <button
                    onClick={() => { setShowUserMenu(false); onViewUser(); }}
                    className="w-full px-4 py-3 flex items-center gap-3 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <User className="w-4 h-4 text-gray-400" />
                    Ver usuario
                  </button>
                  <div className="px-4 py-3 flex items-center gap-3 text-sm text-gray-700 border-t border-gray-50">
                    <Settings className="w-4 h-4 text-gray-400" />
                    <span className="font-medium">PIN: {pin}</span>
                  </div>
                  <button
                    onClick={() => { setShowUserMenu(false); onLogout(); }}
                    className="w-full px-4 py-3 flex items-center gap-3 text-sm text-rose-600 hover:bg-rose-50 transition-colors border-t border-gray-50"
                  >
                    <LogOut className="w-4 h-4" />
                    Cerrar sesión
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-6 pt-24 pb-12">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center mb-12"
        >
          <h1 className="text-4xl font-semibold text-gray-900 mb-4">
            Crea tus asignaturas, sube tus apuntes
          </h1>
          <p className="text-gray-500 text-lg">
            Web oficial de Voice Quizzer, generador de cuestionarios por voz de Alexa.
          </p>
        </motion.div>

        {/* Search Bar */}
        <div className="relative mb-8">
          <div className="absolute inset-y-0 left-5 flex items-center pointer-events-none">
            <Search className="w-5 h-5 text-gray-400" />
          </div>
          <input
            type="text"
            placeholder="Busca tu asignatura..."
            className="w-full pl-14 pr-6 py-5 bg-tepro-gray border border-gray-200 rounded-2xl text-lg focus:outline-none focus:ring-2 focus:ring-tepro-orange/20 focus:border-tepro-orange transition-all shadow-sm"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Create Button */}
        <div className="flex justify-center mb-16">
          <button
            onClick={() => setShowCreatePopup(true)}
            className="flex items-center gap-2 px-8 py-4 bg-tepro-orange text-white rounded-2xl font-bold hover:bg-orange-700 transition-all shadow-lg active:scale-95"
          >
            <Plus className="w-5 h-5" />
            Crear Asignatura
          </button>
        </div>

        {/* Grid */}
        {loading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="w-8 h-8 text-tepro-orange animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-gray-400 text-lg">
              {asignaturas.length === 0
                ? 'Aún no tienes asignaturas. ¡Crea la primera!'
                : 'No se encontraron asignaturas con ese nombre.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {filtered.map((asignatura, index) => (
              <motion.div
                key={asignatura.nombre_asignatura}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: index * 0.1 }}
                onClick={() => onSelectAsignatura(asignatura)}
                className="group p-6 bg-white border border-gray-100 rounded-2xl hover:border-tepro-orange hover:shadow-md transition-all cursor-pointer flex flex-col justify-between"
              >
                <div>
                  <div className="w-12 h-12 bg-gray-50 rounded-xl flex items-center justify-center mb-4 group-hover:bg-orange-50 transition-colors">
                    {getIcon(asignatura.icono)}
                  </div>
                  <h3 className="text-xl font-semibold text-gray-900 mb-2">{asignatura.nombre_asignatura}</h3>
                  <p className="text-gray-500 text-sm leading-relaxed">{asignatura.descripcion}</p>
                </div>
                <div className="mt-6 flex items-center justify-end">
                  <div className="w-8 h-8 rounded-full bg-gray-50 flex items-center justify-center group-hover:bg-tepro-orange group-hover:text-white transition-all">
                    <ArrowRight className="w-4 h-4" />
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </main>

      {/* Create Popup */}
      <AnimatePresence>
        {showCreatePopup && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[100] p-6">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8"
            >
              <div className="flex items-center justify-between mb-6">
                <div className="w-12 h-12 bg-orange-50 rounded-2xl flex items-center justify-center">
                  <Plus className="w-6 h-6 text-tepro-orange" />
                </div>
                <button
                  onClick={() => { setShowCreatePopup(false); setCreateError(''); }}
                  className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                >
                  <X className="w-5 h-5 text-gray-400" />
                </button>
              </div>

              <h3 className="text-2xl font-bold text-gray-900 mb-2">Nueva Asignatura</h3>
              <p className="text-gray-500 text-sm mb-8">
                Crea una nueva base de conocimiento para tus cuestionarios.
              </p>

              {createError && (
                <div className="mb-4 p-3 bg-red-50 text-red-600 text-sm font-medium rounded-lg border border-red-100">
                  {createError}
                </div>
              )}

              <form onSubmit={handleCreateAsignatura} className="space-y-6">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">Nombre</label>
                  <input
                    type="text"
                    required
                    value={newAsignatura.name}
                    onChange={(e) => setNewAsignatura({ ...newAsignatura, name: e.target.value })}
                    placeholder="Ej. Matemáticas II"
                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-tepro-orange/20 focus:border-tepro-orange transition-all"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">Descripción</label>
                  <textarea
                    rows={3}
                    required
                    value={newAsignatura.description}
                    onChange={(e) => setNewAsignatura({ ...newAsignatura, description: e.target.value })}
                    placeholder="Describe brevemente el contenido..."
                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-tepro-orange/20 focus:border-tepro-orange transition-all resize-none"
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-3">Icono</label>
                  <div className="grid grid-cols-6 gap-2 max-h-32 overflow-y-auto p-1 border border-gray-100 rounded-xl bg-gray-50/50 scrollbar-thin scrollbar-thumb-gray-200">
                    {AVAILABLE_ICONS.map((iconName) => (
                      <button
                        key={iconName}
                        type="button"
                        onClick={() => setNewAsignatura({ ...newAsignatura, icon: iconName })}
                        className={`p-2 rounded-xl border-2 transition-all flex items-center justify-center ${
                          newAsignatura.icon === iconName
                            ? 'border-tepro-orange bg-white text-tepro-orange shadow-sm'
                            : 'border-transparent text-gray-400 hover:bg-white hover:text-gray-600'
                        }`}
                      >
                        {getIcon(iconName, 'w-5 h-5')}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => { setShowCreatePopup(false); setCreateError(''); }}
                    className="flex-1 py-3 bg-gray-50 text-gray-600 rounded-xl font-bold hover:bg-gray-100 transition-all"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={creating}
                    className="flex-1 py-3 bg-tepro-orange text-white rounded-xl font-bold hover:bg-orange-700 transition-all shadow-md disabled:opacity-60 flex items-center justify-center gap-2"
                  >
                    {creating && <Loader2 className="w-4 h-4 animate-spin" />}
                    {creating ? 'Creando...' : 'Crear'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
