import React, { useState, useEffect, useRef } from 'react';
import {
  ChevronLeft, User, Mail, Shield, Calendar, Edit2, Lock, Save, X,
  Trash2, AlertTriangle, Loader2, Camera,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { dynamo, hashPassword, s3Upload, s3Delete, s3PresignedUrl } from '../lib/aws';

interface UserProfileProps {
  email: string;
  onBack: () => void;
  onDeleted: () => void;
  onPhotoUpdated: (foto: string | null) => void;
}

// ── DynamoDB helpers ──────────────────────────────────────────────────────────

async function cargarUsuario(email: string) {
  const res  = await dynamo('DynamoDB_20120810.GetItem', {
    TableName: 'VQ_Usuarios',
    Key: { email: { S: email } },
  });
  const data = await res.json();
  if (!data.Item) return { error: 'Usuario no encontrado.' };
  return {
    user: {
      nombre:        data.Item.nombre_usuario?.S ?? '',
      email:         data.Item.email?.S ?? email,
      pin:           data.Item.pin_vinculacion?.S ?? '—',
      fechaCreacion: data.Item.fecha_creacion?.S?.slice(0, 10) ?? '—',
      fotoKey:       data.Item.foto?.S ?? '',
    },
  };
}

async function actualizarNombre(email: string, nuevoNombre: string) {
  const res = await dynamo('DynamoDB_20120810.UpdateItem', {
    TableName: 'VQ_Usuarios',
    Key: { email: { S: email } },
    UpdateExpression: 'SET nombre_usuario = :n',
    ExpressionAttributeValues: { ':n': { S: nuevoNombre } },
  });
  return res.ok ? {} : { error: 'Error actualizando el nombre.' };
}

async function cambiarPassword(email: string, oldPwd: string, newPwd: string) {
  const res  = await dynamo('DynamoDB_20120810.GetItem', {
    TableName: 'VQ_Usuarios',
    Key: { email: { S: email } },
  });
  const data = await res.json();
  if (!data.Item) return { error: 'Usuario no encontrado.' };
  if (data.Item.password_hash.S !== await hashPassword(oldPwd))
    return { error: 'La contraseña antigua no es correcta.' };

  const upd = await dynamo('DynamoDB_20120810.UpdateItem', {
    TableName: 'VQ_Usuarios',
    Key: { email: { S: email } },
    UpdateExpression: 'SET password_hash = :h',
    ExpressionAttributeValues: { ':h': { S: await hashPassword(newPwd) } },
  });
  return upd.ok ? {} : { error: 'Error guardando la nueva contraseña.' };
}

async function eliminarCuenta(email: string) {
  const res = await dynamo('DynamoDB_20120810.DeleteItem', {
    TableName: 'VQ_Usuarios',
    Key: { email: { S: email } },
  });
  return res.ok ? {} : { error: 'Error eliminando la cuenta.' };
}

async function actualizarFoto(email: string, fotoKey: string | null) {
  if (fotoKey) {
    await dynamo('DynamoDB_20120810.UpdateItem', {
      TableName: 'VQ_Usuarios',
      Key: { email: { S: email } },
      UpdateExpression: 'SET foto = :f',
      ExpressionAttributeValues: { ':f': { S: fotoKey } },
    });
  } else {
    await dynamo('DynamoDB_20120810.UpdateItem', {
      TableName: 'VQ_Usuarios',
      Key: { email: { S: email } },
      UpdateExpression: 'REMOVE foto',
    });
  }
}

// ── Componente ────────────────────────────────────────────────────────────────

export default function UserProfile({ email, onBack, onDeleted, onPhotoUpdated }: UserProfileProps) {
  const [user, setUser]             = useState({ nombre: '', email, pin: '—', fechaCreacion: '—', fotoKey: '' });
  const [loadingUser, setLoadingUser] = useState(true);
  const [globalError, setGlobalError] = useState('');
  const [fotoUrl, setFotoUrl]         = useState<string | null>(null);
  const [uploadingFoto, setUploadingFoto] = useState(false);
  const fotoInputRef = useRef<HTMLInputElement>(null);

  const [isEditingName, setIsEditingName] = useState(false);
  const [newName, setNewName]             = useState('');
  const [savingName, setSavingName]       = useState(false);

  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwords, setPasswords]   = useState({ old: '', new: '', confirm: '' });
  const [passwordError, setPasswordError] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting]                   = useState(false);

  useEffect(() => {
    cargarUsuario(email).then(async res => {
      if (res.error) { setGlobalError(res.error); }
      else {
        const fotoKey = (res.user as any).fotoKey ?? '';
        setUser({ ...res.user!, fotoKey });
        setNewName(res.user!.nombre);
        if (fotoKey) {
          const url = await s3PresignedUrl(fotoKey, 3600).catch(() => null);
          setFotoUrl(url);
        }
      }
      setLoadingUser(false);
    });
  }, [email]);

  const handleUpdateName = async () => {
    if (!newName.trim()) return;
    setSavingName(true);
    const res = await actualizarNombre(email, newName.trim());
    if (res.error) { setGlobalError(res.error); }
    else { setUser(u => ({ ...u, nombre: newName.trim() })); setIsEditingName(false); }
    setSavingName(false);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');
    if (passwords.new !== passwords.confirm) return setPasswordError('Las nuevas contraseñas no coinciden.');
    if (!passwords.old) return setPasswordError('Debes introducir la contraseña antigua.');
    setSavingPassword(true);
    const res = await cambiarPassword(email, passwords.old, passwords.new);
    if (res.error) { setPasswordError(res.error); }
    else { setIsChangingPassword(false); setPasswords({ old: '', new: '', confirm: '' }); }
    setSavingPassword(false);
  };

  const handleDeleteAccount = async () => {
    setDeleting(true);
    const res = await eliminarCuenta(email);
    if (res.error) { setGlobalError(res.error); setDeleting(false); return; }
    setDeleting(false);
    setShowDeleteConfirm(false);
    onDeleted();
  };

  if (loadingUser) return (
    <div className="min-h-screen bg-tepro-gray flex items-center justify-center">
      <Loader2 className="w-8 h-8 text-tepro-orange animate-spin" />
    </div>
  );

  return (
    <div className="min-h-screen bg-tepro-gray">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-8 py-4 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={onBack} className="p-2 hover:bg-gray-100 rounded-full transition-colors">
              <ChevronLeft className="w-5 h-5 text-gray-500" />
            </button>
            <div className="flex items-center gap-2">
              <User className="w-6 h-6 text-tepro-orange" />
              <h1 className="text-xl font-bold text-gray-900">Perfil de Usuario</h1>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-8 py-12">
        {globalError && (
          <div className="mb-6 p-4 bg-red-50 text-red-600 text-sm font-medium rounded-xl border border-red-100">
            {globalError}
          </div>
        )}

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden"
        >
          {/* Cover */}
          <div className="h-32 bg-orange-50 relative">
            <div className="absolute -bottom-12 left-8">
              <div className="w-24 h-24 bg-white rounded-2xl shadow-md flex items-center justify-center border-4 border-white">
                <User className="w-12 h-12 text-tepro-orange" />
              </div>
            </div>
          </div>

          <div className="pt-16 pb-8 px-8">
            {/* Nombre + PIN */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
              <div className="flex-1">
                {isEditingName ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newName}
                      onChange={e => setNewName(e.target.value)}
                      className="text-2xl font-bold text-gray-900 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-tepro-orange/20"
                      autoFocus
                    />
                    <button onClick={handleUpdateName} disabled={savingName}
                      className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {savingName ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                    </button>
                    <button onClick={() => { setIsEditingName(false); setNewName(user.nombre); }}
                      className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 group">
                    <h2 className="text-2xl font-bold text-gray-900">{user.nombre}</h2>
                    <button onClick={() => setIsEditingName(true)}
                      className="p-1 text-gray-400 hover:text-tepro-orange opacity-0 group-hover:opacity-100 transition-all"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
                <p className="text-gray-500 font-medium">Estudiante</p>
              </div>
              <div className="px-4 py-2 bg-orange-50 text-tepro-orange rounded-xl text-sm font-bold border border-orange-100">
                PIN Alexa: {user.pin}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
              {/* Información */}
              <div className="space-y-8">
                <div>
                  <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-6">Información de Contacto</h3>
                  <div className="space-y-4">
                    <div className="flex items-center gap-3 text-gray-600">
                      <div className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center">
                        <Mail className="w-5 h-5 text-gray-400" />
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 font-bold uppercase">Email</p>
                        <p className="text-sm font-medium">{user.email}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-gray-600">
                      <div className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center">
                        <Calendar className="w-5 h-5 text-gray-400" />
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 font-bold uppercase">Miembro desde</p>
                        <p className="text-sm font-medium">{user.fechaCreacion}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Seguridad */}
              <div className="space-y-8">
                <div>
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest">Seguridad</h3>
                    {!isChangingPassword && (
                      <button onClick={() => setIsChangingPassword(true)}
                        className="text-xs font-bold text-tepro-orange hover:underline flex items-center gap-1"
                      >
                        <Lock className="w-3 h-3" />
                        Cambiar contraseña
                      </button>
                    )}
                  </div>

                  {isChangingPassword ? (
                    <form onSubmit={handleChangePassword} className="space-y-4 bg-gray-50 p-4 rounded-2xl border border-gray-100">
                      {passwordError && <p className="text-xs font-bold text-red-500">{passwordError}</p>}
                      {(['old', 'new', 'confirm'] as const).map((field, idx) => (
                        <div key={field} className="space-y-1">
                          <label className="text-[10px] font-bold text-gray-400 uppercase">
                            {idx === 0 ? 'Contraseña Antigua' : idx === 1 ? 'Nueva Contraseña' : 'Confirmar Nueva'}
                          </label>
                          <input type="password" value={passwords[field]}
                            onChange={e => setPasswords({ ...passwords, [field]: e.target.value })}
                            className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-tepro-orange/20"
                            placeholder="••••••••" required />
                        </div>
                      ))}
                      <div className="flex gap-2 pt-2">
                        <button type="submit" disabled={savingPassword}
                          className="flex-1 bg-tepro-orange text-white py-2 rounded-lg text-xs font-bold hover:bg-orange-600 transition-colors disabled:opacity-60 flex items-center justify-center gap-1"
                        >
                          {savingPassword && <Loader2 className="w-3 h-3 animate-spin" />}
                          Actualizar
                        </button>
                        <button type="button" onClick={() => setIsChangingPassword(false)}
                          className="flex-1 bg-white text-gray-500 py-2 rounded-lg text-xs font-bold border border-gray-200 hover:bg-gray-50 transition-colors"
                        >
                          Cancelar
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex items-center gap-3 text-gray-600">
                      <div className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center">
                        <Shield className="w-5 h-5 text-gray-400" />
                      </div>
                      <div>
                        <p className="text-xs text-gray-400 font-bold uppercase">Estado de la Cuenta</p>
                        <p className="text-sm font-medium text-emerald-600">Verificada</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Zona de Peligro */}
            <div className="mt-12 pt-8 border-t border-gray-100">
              <h3 className="text-xs font-bold text-red-400 uppercase tracking-widest mb-4">Zona de Peligro</h3>
              <div className="bg-red-50/50 border border-red-100 rounded-2xl p-6 flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-bold text-red-900">Borrar Cuenta</h4>
                  <p className="text-xs text-red-600/70">Esta acción es permanente y no se puede deshacer.</p>
                </div>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="px-6 py-2 bg-white text-red-600 border border-red-200 rounded-xl font-bold hover:bg-red-600 hover:text-white transition-all shadow-sm text-sm"
                >
                  Borrar mi cuenta
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      </main>

      {/* Modal confirmación borrado */}
      <AnimatePresence>
        {showDeleteConfirm && (
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
              <h3 className="text-2xl font-bold text-gray-900 mb-2">¿Estás seguro?</h3>
              <p className="text-gray-500 text-sm mb-8 leading-relaxed">
                Estás a punto de borrar tu cuenta de Voice Quizzer. Se eliminarán todas tus asignaturas, unidades y progreso. Esta acción es irreversible.
              </p>
              <div className="flex gap-3">
                <button onClick={() => setShowDeleteConfirm(false)} disabled={deleting}
                  className="flex-1 py-3 bg-gray-50 text-gray-600 rounded-xl font-bold hover:bg-gray-100 transition-all disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button onClick={handleDeleteAccount} disabled={deleting}
                  className="flex-1 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-all shadow-md disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {deleting && <Loader2 className="w-4 h-4 animate-spin" />}
                  {deleting ? 'Borrando...' : 'Borrar Cuenta'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
