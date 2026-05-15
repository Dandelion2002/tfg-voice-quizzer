// Autor:   María León Pérez
// Resumen: Componente raíz de la SPA. Gestiona el enrutamiento mediante un estado
//          'currentScreen' (en lugar de React Router) porque la app tiene una
//          jerarquía de pantallas plana y predecible. Almacena el usuario actual,
//          la asignatura seleccionada y la unidad seleccionada como estado compartido,
//          pasándolo hacia abajo por props a cada pantalla.
import React, { useState } from 'react';
import Home from './components/Home';
import GestionAsignatura from './components/GestionAsignatura';
import GestionUnidad from './components/GestionUnidad';
import Login from './components/Login';
import UserProfile from './components/UserProfile';
import History from './components/History';
import Estadisticas from './components/Estadisticas';
import { CurrentUser, Asignatura, Unidad } from './types';

type Screen =
  | 'login'
  | 'home'
  | 'gestion-asignatura'
  | 'gestion-unidad'
  | 'user-profile'
  | 'history'
  | 'estadisticas';

export default function App() {
  const [currentScreen, setCurrentScreen]           = useState<Screen>('login');
  const [currentUser, setCurrentUser]               = useState<CurrentUser | null>(null);
  const [selectedAsignatura, setSelectedAsignatura] = useState<Asignatura | null>(null);
  const [selectedUnidad, setSelectedUnidad]         = useState<Unidad | null>(null);

  const handleLogin = (user: CurrentUser) => {
    setCurrentUser(user);
    setCurrentScreen('home');
  };

  const handleSelectAsignatura = (asignatura: Asignatura) => {
    setSelectedAsignatura(asignatura);
    setCurrentScreen('gestion-asignatura');
  };

  const handleGoToHistory = () => setCurrentScreen('history');
  const handleViewUser    = () => setCurrentScreen('user-profile');

  const handleLogout = () => {
    setCurrentUser(null);
    setSelectedAsignatura(null);
    setSelectedUnidad(null);
    setCurrentScreen('login');
  };

  const handleEditUnidad = (unidad: Unidad) => {
    setSelectedUnidad(unidad);
    setCurrentScreen('gestion-unidad');
  };

  const handleCreateUnidad = () => {
    setSelectedUnidad(null);
    setCurrentScreen('gestion-unidad');
  };

  const handleViewStats = (unidad: Unidad) => {
    setSelectedUnidad(unidad);
    setCurrentScreen('estadisticas');
  };

  const handleBackToHome = () => {
    setCurrentScreen('home');
    setSelectedAsignatura(null);
    setSelectedUnidad(null);
  };

  const handleBackToGestion = () => {
    setSelectedUnidad(null);
    setCurrentScreen('gestion-asignatura');
  };

  return (
    <div className="min-h-screen font-sans antialiased">
      {currentScreen === 'login' && (
        <Login onLogin={handleLogin} />
      )}

      {currentScreen === 'home' && currentUser && (
        <Home
          email={currentUser.email}
          pin={currentUser.pin}
          fotoKey={currentUser.foto}
          onSelectAsignatura={handleSelectAsignatura}
          onGoToHistory={handleGoToHistory}
          onViewUser={handleViewUser}
          onLogout={handleLogout}
        />
      )}

      {currentScreen === 'user-profile' && currentUser && (
        <UserProfile
          email={currentUser.email}
          onBack={handleBackToHome}
          onDeleted={handleLogout}
          onPhotoUpdated={(foto) => setCurrentUser(u => u ? { ...u, foto: foto ?? undefined } : u)}
        />
      )}

      {currentScreen === 'history' && currentUser && (
        <History
          email={currentUser.email}
          onBack={handleBackToHome}
        />
      )}

      {currentScreen === 'estadisticas' && currentUser && selectedUnidad && (
        <Estadisticas
          email={currentUser.email}
          unidad={selectedUnidad}
          onBack={handleBackToGestion}
        />
      )}

      {currentScreen === 'gestion-asignatura' && currentUser && selectedAsignatura && (
        <GestionAsignatura
          email={currentUser.email}
          asignatura={selectedAsignatura}
          onAsignaturaUpdated={setSelectedAsignatura}
          onAsignaturaDeleted={handleBackToHome}
          onBack={handleBackToHome}
          onLogout={handleLogout}
          onEditUnidad={handleEditUnidad}
          onCreateUnidad={handleCreateUnidad}
          onViewStats={handleViewStats}
        />
      )}

      {currentScreen === 'gestion-unidad' && currentUser && selectedAsignatura && (
        <GestionUnidad
          email={currentUser.email}
          nombreAsignatura={selectedAsignatura.nombre_asignatura}
          unidad={selectedUnidad ?? undefined}
          onBack={handleBackToGestion}
        />
      )}
    </div>
  );
}
