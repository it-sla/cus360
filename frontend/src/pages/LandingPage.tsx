
import { useNavigate } from 'react-router-dom';
import { ContainerScroll } from '@/components/ui/container-scroll-animation';
import { ArrowRight } from 'lucide-react';

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <div
      className="flex min-h-screen flex-col overflow-hidden"
      style={{ backgroundColor: '#0F0F0F', color: '#FAFAFA' }}
    >
      <div className="absolute top-6 right-8 z-50">
        <div onClick={() => navigate('/login')}>
          <button className="flex h-10 items-center gap-2 rounded-full px-6 text-sm font-semibold text-white transition-colors hover:bg-[#EA580C]"
            style={{ backgroundColor: '#F97316' }}
          >
            Sign in <ArrowRight size={16} />
          </button>
        </div>
      </div>

      <ContainerScroll
        titleComponent={
          <>
            <h1 className="mb-4 text-4xl font-semibold text-[#FAFAFA] md:text-5xl">
              Next Generation Logistics with <br />
              <span className="mt-2 text-5xl font-black leading-none md:text-[6rem]" style={{ color: '#FB923C' }}>
                Shangrila Intelligence
              </span>
            </h1>
          </>
        }
      >
        <img
          src="https://images.unsplash.com/photo-1551288049-bebda4e38f71?q=80&w=2070&auto=format&fit=crop"
          alt="Dashboard Mockup"
          className="mx-auto h-full w-full rounded-2xl object-cover object-left-top"
          style={{ border: '1px solid rgba(249, 115, 22, 0.35)' }}
          draggable={false}
        />
      </ContainerScroll>
    </div>
  );
}
