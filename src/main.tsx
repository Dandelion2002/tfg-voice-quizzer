// Autor:   María León Pérez
// Resumen: Punto de entrada de la aplicación React. Monta el componente raíz <App>
//          en el elemento #root del index.html. StrictMode activa advertencias
//          adicionales de React en desarrollo (doble renderizado de efectos).
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
