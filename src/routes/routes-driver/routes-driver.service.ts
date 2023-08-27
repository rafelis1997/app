import { DirectionsResponseData } from '@googlemaps/google-maps-services-js/dist/directions';
import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import { PrismaService } from 'src/prisma/prisma/prisma.service';
import { Counter } from 'prom-client';
import { InjectMetric } from '@willsoto/nestjs-prometheus';

@Injectable()
export class RoutesDriverService {
  constructor(
    private prismaService: PrismaService,
    @InjectQueue('kafka-producer') private kafkaQueue: Queue,
    @InjectMetric('route_started_counter')
    private routeStartedCounter: Counter,
    @InjectMetric('route_finished_counter')
    private routeFinishedCounter: Counter,
  ) {}

  async createOrUpdate(dto: { route_id: string; lat: number; lng: number }) {
    const countRouteDriver = await this.prismaService.routeDriver.count({
      where: {
        route_id: dto.route_id,
      },
    });

    const routeDriver = await this.prismaService.routeDriver.upsert({
      include: {
        route: true,
      },
      where: {
        route_id: dto.route_id,
      },
      create: {
        route_id: dto.route_id,
        points: {
          set: {
            location: {
              lat: dto.lat,
              lng: dto.lng,
            },
          },
        },
      },
      update: {
        points: {
          push: {
            location: {
              lat: dto.lat,
              lng: dto.lng,
            },
          },
        },
      },
    });

    if (countRouteDriver === 0) {
      this.routeStartedCounter.inc();
      await this.kafkaQueue.add({
        event: 'RouteStarted',
        id: routeDriver.id,
        name: routeDriver.route.name,
        started_at: new Date().toISOString(),
        lat: dto.lat,
        lng: dto.lng,
      });

      return routeDriver;
    }

    const directions: DirectionsResponseData = JSON.parse(
      routeDriver.route.directions as string,
    );

    const lastPoint =
      directions.routes[0].legs[0].steps[
        directions.routes[0].legs[0].steps.length - 1
      ];

    if (
      lastPoint.end_location.lat === dto.lat &&
      lastPoint.end_location.lng === dto.lng
    ) {
      this.routeFinishedCounter.inc();
      await this.kafkaQueue.add({
        event: 'RouteFinished',
        id: routeDriver.id,
        name: routeDriver.route.name,
        finished_at: new Date().toISOString(),
        lat: dto.lat,
        lng: dto.lng,
      });

      return routeDriver;
    }

    await this.kafkaQueue.add({
      event: 'DriverMoved',
      id: routeDriver.id,
      name: routeDriver.route.name,
      started_at: new Date().toISOString(),
      lat: dto.lat,
      lng: dto.lng,
    });

    return routeDriver;
  }
}
