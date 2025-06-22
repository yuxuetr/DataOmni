import React from 'react';
import { Database, Zap, BarChart3, Globe, Shield, Users } from 'lucide-react';

interface WelcomeScreenProps {
  onConnect: () => void;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onConnect }) => {
  const features = [
    {
      icon: <Database className="w-6 h-6" />,
      title: '多数据库支持',
      description: '支持关系型和非关系型数据库，统一管理您的数据源'
    },
    {
      icon: <Zap className="w-6 h-6" />,
      title: '高性能查询',
      description: '优化的SQL编辑器，支持语法高亮和智能提示'
    },
    {
      icon: <BarChart3 className="w-6 h-6" />,
      title: '数据可视化',
      description: '直观的表格视图，快速浏览和分析数据'
    },
    {
      icon: <Globe className="w-6 h-6" />,
      title: '跨平台',
      description: '基于Tauri构建，支持Windows、macOS和Linux'
    },
    {
      icon: <Shield className="w-6 h-6" />,
      title: '安全可靠',
      description: '本地存储连接信息，保护您的数据安全'
    },
    {
      icon: <Users className="w-6 h-6" />,
      title: '开发者友好',
      description: '专为数据工程师和开发者设计的现代化界面'
    }
  ];

  return (
    <div className="h-full flex flex-col items-center justify-center bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50">
      {/* 主要内容区域 */}
      <div className="text-center max-w-4xl mx-auto px-8">
        {/* 软件名称 */}
        <div className="mb-8">
          <h1 className="text-6xl font-bold mb-4 bg-gradient-to-r from-blue-600 via-purple-600 to-indigo-600 bg-clip-text text-transparent">
            DataOmni
          </h1>
          <p className="text-xl text-gray-600 max-w-2xl mx-auto leading-relaxed">
            现代化的数据库管理工具，让数据操作变得简单高效
          </p>
        </div>

        {/* 功能特性网格 */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
          {features.map((feature, index) => (
            <div
              key={index}
              className="bg-white/70 backdrop-blur-sm rounded-xl p-6 border border-white/20 shadow-lg hover:shadow-xl transition-all duration-300 hover:scale-105"
            >
              <div className="flex items-center justify-center w-12 h-12 bg-gradient-to-r from-blue-500 to-purple-500 rounded-lg mb-4 mx-auto">
                <div className="text-white">
                  {feature.icon}
                </div>
              </div>
              <h3 className="text-lg font-semibold text-gray-800 mb-2">
                {feature.title}
              </h3>
              <p className="text-gray-600 text-sm leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>

        {/* 连接按钮 */}
        <div className="space-y-4">
          <button
            onClick={onConnect}
            className="inline-flex items-center space-x-3 px-8 py-4 bg-gradient-to-r from-blue-600 to-purple-600 text-white font-semibold rounded-xl shadow-lg hover:shadow-xl transform hover:scale-105 transition-all duration-300"
          >
            <Database className="w-5 h-5" />
            <span>连接到数据库</span>
          </button>
          
          <p className="text-gray-500 text-sm">
            开始您的数据探索之旅
          </p>
        </div>
      </div>

      {/* 装饰性背景元素 */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-gradient-to-br from-blue-400/20 to-purple-400/20 rounded-full blur-3xl"></div>
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-gradient-to-tr from-indigo-400/20 to-pink-400/20 rounded-full blur-3xl"></div>
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-gradient-to-r from-purple-400/10 to-blue-400/10 rounded-full blur-3xl"></div>
      </div>
    </div>
  );
}; 
