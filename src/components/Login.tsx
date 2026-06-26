// Autor:   María León Pérez
// Resumen: Pantalla de autenticación con doble modo: inicio de sesión y registro.
//          El registro genera un PIN de 6 dígitos aleatorio que el usuario debe
//          apuntar para vincular su dispositivo Alexa. Las contraseñas se hashean
//          con SHA-256 en el cliente (hashPassword) antes de enviarse a DynamoDB:
//          nunca viajan ni se almacenan en texto plano.
//          La contraseña de registro debe cumplir: mínimo 8 caracteres, al menos
//          una mayúscula y al menos un número (validado en cliente antes de enviar).
import React, { useState } from 'react';
import { motion } from 'motion/react';
import { LogIn, UserPlus, ArrowRight, Check, X } from 'lucide-react';
import Logo from './Logo';
import { dynamo, hashPassword } from '../lib/aws';
import { CurrentUser } from '../types';

/** Reglas de complejidad que debe cumplir la contraseña al registrarse. */
const passwordRules = [
  { id: 'length',    label: 'Mínimo 8 caracteres',  test: (p: string) => p.length >= 8 },
  { id: 'uppercase', label: 'Al menos una mayúscula', test: (p: string) => /[A-Z]/.test(p) },
  { id: 'number',    label: 'Al menos un número',    test: (p: string) => /[0-9]/.test(p) },
];

/**
 * Autentica al usuario comparando el hash SHA-256 de la contraseña con el almacenado
 * en DynamoDB. Devuelve el objeto CurrentUser si coincide, o un mensaje de error.
 */
async function iniciarSesion(email: string, password: string): Promise<{ user?: CurrentUser; error?: string }> {
  const res  = await dynamo('DynamoDB_20120810.GetItem', {
    TableName: 'VQ_Usuarios',
    Key: { email: { S: email } },
  });
  const data = await res.json();
  if (!data.Item) return { error: 'No existe ninguna cuenta con este email.' };
  if (data.Item.password_hash.S !== await hashPassword(password)) return { error: 'Contraseña incorrecta.' };
  return {
    user: {
      email:  data.Item.email.S,
      nombre: data.Item.nombre_usuario.S,
      pin:    data.Item.pin_vinculacion.S,
      foto:   data.Item.foto?.S ?? undefined,
    },
  };
}

/**
 * Crea una nueva cuenta en VQ_Usuarios con un PIN de 6 dígitos generado aleatoriamente.
 * La condición 'attribute_not_exists(id_unidad)' equivalente se implementa verificando
 * primero si el email ya existe (GetItem) antes del PutItem, evitando duplicados.
 */
async function registrarUsuario(
  nombre: string,
  email: string,
  password: string
): Promise<{ pin?: string; error?: string }> {
  const check = await dynamo('DynamoDB_20120810.GetItem', {
    TableName: 'VQ_Usuarios',
    Key: { email: { S: email } },
  });
  if ((await check.json()).Item) return { error: 'Este email ya está registrado.' };

  const pin = String(Math.floor(100000 + Math.random() * 900000));
  await dynamo('DynamoDB_20120810.PutItem', {
    TableName: 'VQ_Usuarios',
    Item: {
      email:           { S: email },
      nombre_usuario:  { S: nombre },
      password_hash:   { S: await hashPassword(password) },
      pin_vinculacion: { S: pin },
      fecha_creacion:  { S: new Date().toISOString() },
      alexa_user_id:   { S: 'PENDIENTE' },
    },
  });
  return { pin };
}

interface LoginProps {
  onLogin: (user: CurrentUser) => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [isLogin, setIsLogin]                 = useState(true);
  const [name, setName]                       = useState('');
  const [email, setEmail]                     = useState('');
  const [password, setPassword]               = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError]                     = useState('');
  const [successMsg, setSuccessMsg]           = useState('');
  const [loading, setLoading]                 = useState(false);

  const passwordValid = passwordRules.every(r => r.test(password));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMsg('');

    if (!isLogin) {
      if (!passwordRules.every(r => r.test(password))) {
        setError('La contraseña no cumple los requisitos de seguridad.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Las contraseñas no coinciden.');
        return;
      }
    }

    setLoading(true);
    try {
      if (isLogin) {
        const res = await iniciarSesion(email, password);
        res.error ? setError(res.error) : onLogin(res.user!);
      } else {
        const res = await registrarUsuario(name, email, password);
        if (res.error) { setError(res.error); }
        else {
          setSuccessMsg(`¡Cuenta creada! Tu PIN de Alexa es: ${res.pin}. ¡Apúntalo!`);
          setTimeout(() => { setIsLogin(true); setSuccessMsg(''); }, 6000);
        }
      }
    } catch {
      setError('Error conectando con AWS. Revisa tu conexión.');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-tepro-gray p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8"
      >
        <div className="flex flex-col items-center mb-4">
          <Logo className="w-40 h-40 mb-1" />
          <p className="text-gray-500 mt-1">
            {isLogin ? 'Inicia sesión para continuar' : 'Crea una cuenta para empezar'}
          </p>
        </div>

        {error      && <div className="mb-4 p-3 bg-red-50 text-red-600 text-sm font-medium rounded-lg border border-red-100">{error}</div>}
        {successMsg && <div className="mb-4 p-3 bg-green-50 text-green-700 text-sm font-medium rounded-lg border border-green-100">{successMsg}</div>}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nombre Completo</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-tepro-orange focus:border-transparent outline-none transition-all"
                placeholder="Tu nombre" required />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-tepro-orange focus:border-transparent outline-none transition-all"
              placeholder="tu@email.com" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Contraseña</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-tepro-orange focus:border-transparent outline-none transition-all"
              placeholder="••••••••" required />
            {!isLogin && password.length > 0 && (
              <ul className="mt-2 space-y-1">
                {passwordRules.map(rule => {
                  const ok = rule.test(password);
                  return (
                    <li key={rule.id} className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${ok ? 'text-emerald-600' : 'text-red-500'}`}>
                      {ok
                        ? <Check className="w-3.5 h-3.5 shrink-0" />
                        : <X    className="w-3.5 h-3.5 shrink-0" />}
                      {rule.label}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {!isLogin && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Confirmar Contraseña</label>
              <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-tepro-orange focus:border-transparent outline-none transition-all"
                placeholder="••••••••" required />
            </div>
          )}
          <button type="submit" disabled={loading}
            className="w-full bg-tepro-orange text-white py-3 rounded-lg font-semibold flex items-center justify-center gap-2 hover:bg-orange-600 transition-colors mt-6 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading
              ? <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
              : isLogin ? <LogIn className="w-5 h-5" /> : <UserPlus className="w-5 h-5" />}
            {loading ? 'Cargando...' : isLogin ? 'Iniciar Sesión' : 'Registrarse'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button onClick={() => { setIsLogin(!isLogin); setError(''); setSuccessMsg(''); }}
            className="text-tepro-orange hover:underline text-sm font-medium"
          >
            {isLogin ? '¿No tienes cuenta? Regístrate' : '¿Ya tienes cuenta? Inicia sesión'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
