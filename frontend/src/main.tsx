import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import PrivacyPage from "./pages/Privacy";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="*" element={
          <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}>
            <App />
          </ClerkProvider>
        } />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
