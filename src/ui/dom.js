import {
  createElement, Activity, Anchor, BadgePlus, Bell, Blend, BookOpen, Check,
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, CircleDot,
  CircleDotDashed, CircleHelp, Cloud, Compass, Cross, Crosshair, Diamond,
  Download, Droplets, FastForward, Flower2, Footprints, Ghost, Globe2, Hammer,
  Hand, Heart, HeartHandshake, HeartPulse, Image, LocateFixed, Map, MapPin,
  MessageCircle, Moon, Move, MoveLeft, MoveRight, Orbit, PaintBucket, Paintbrush,
  Palette, Rabbit, Rainbow, RefreshCw, RotateCcw, Search, Send, Settings2, Shield,
  ShieldAlert, ShieldCheck, ShieldPlus, Skull, Sparkle, Sparkles, Star, Stars,
  Sun, SunMedium, Sunrise, Sword, Swords, Telescope, TreePine, UserRound, Users,
  WandSparkles, Waves, Wind, X, Zap,
} from 'lucide';

const icons = {
  Activity, Anchor, BadgePlus, Bell, Blend, BookOpen, Check, ChevronDown,
  ChevronLeft, ChevronRight, ChevronUp, Circle, CircleDot, CircleDotDashed,
  CircleHelp, Cloud, Compass, Cross, Crosshair, Diamond, Download, Droplets,
  FastForward, Flower2, Footprints, Ghost, Globe2, Hammer, Hand, Heart,
  HeartHandshake, HeartPulse, Hearts: HeartHandshake, Image, LocateFixed, Map,
  MapPin, MessageCircle, Moon, Move, MoveLeft, MoveRight, Orbit, PaintBucket,
  Paintbrush, Palette, Rabbit, Rainbow, RefreshCw, RotateCcw, Search, Send,
  Settings2, Shield, ShieldAlert, ShieldCheck, ShieldPlus, Skull, Sparkle,
  Sparkles, Star, Stars, Sun, SunMedium, Sunrise, Sword, Swords, Telescope,
  TreePine, UserRound, Users, WandSparkles, Waves, Wind, X, Zap,
};

export const $ = (selector) => document.querySelector(selector);
export const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const icon = (name, cls = '') => `<i data-lucide="${name}" class="${cls}"></i>`;
export function iconify(root = document) {
  root.querySelectorAll('[data-lucide]').forEach(node => {
    const name = node.dataset.lucide.replace(/(^|-)(\w)/g, (_, dash, char) => char.toUpperCase());
    const definition = icons[name] || icons.Sparkles;
    const element = createElement(definition, { 'stroke-width': 1.7, class: node.className, 'aria-hidden': 'true' });
    node.replaceWith(element);
  });
}
export function formatTime(value) {
  const seconds = Math.max(0, Math.floor(value || 0));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export function formatNumber(value) { return Math.round(value || 0).toLocaleString('en-US'); }
